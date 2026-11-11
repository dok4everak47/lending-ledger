/**
 * 最小 HTTP 入口：把账簿能力暴露成 5 个端点，足够演示「一个人跑通一个业务域」。
 *
 *   node src/api/http.ts          # 默认 8787
 *   PORT=9000 node src/api/http.ts
 *
 *   curl -X POST localhost:8787/transfers \
 *     -H 'Idempotency-Key: pay-TX-1' \
 *     -d '{"transferId":"TX-1","amount":10000,"fee":60}'
 *
 * 错误码是接口契约的一部分：409 = 幂等冲突/状态非法，402 = 余额不足，422 = 分录不合法。
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Account } from '../domain/accounts.ts'
import { DEBIT, CREDIT } from '../domain/accounts.ts'
import { AccountNotFoundError, AlreadyReversedError, Ledger } from '../ledger/ledger.ts'
import { InvalidEntryError, UnbalancedEntryError } from '../domain/journal.ts'
import { InvalidTransitionError } from '../domain/state-machine.ts'
import {
  DuplicateTransferError,
  InsufficientBalanceError,
  TransferNotFoundError,
  getTransfer,
  pay,
  reverseTransfer,
  settle,
} from '../payments/pay.ts'
import { reconcile } from '../recon/reconcile.ts'
import type { ReconLine } from '../recon/reconcile.ts'
import type { Db } from '../store/db.ts'
import { createDb } from '../store/db.ts'
import {
  IdempotencyConflictError,
  IdempotencyInFlightError,
  InvalidIdempotencyKeyError,
} from '../store/idempotency.ts'

const MAX_BODY_BYTES = 1024 * 1024
const UI_PATH = new URL('../../public/index.html', import.meta.url)
const UI_HTML = readFileSync(UI_PATH, 'utf8')

type AppContext = {
  ledger: Ledger
  wallet: Account
  payable: Account
  reserve: Account
  feeRevenue: Account
}

function ensureAccount(ledger: Ledger, code: string, name: string, type: Account['type']): Account {
  try {
    return ledger.account(code)
  } catch (error) {
    if (error instanceof AccountNotFoundError) return ledger.openAccount({ code, name, type })
    throw error
  }
}

function context(ledger: Ledger): AppContext {
  return {
    ledger,
    wallet: ensureAccount(ledger, '2001', '用户钱包', 'LIABILITY'),
    payable: ensureAccount(ledger, '2002', '商户待结算', 'LIABILITY'),
    reserve: ensureAccount(ledger, '1002', '备付金', 'ASSET'),
    feeRevenue: ensureAccount(ledger, '4001', '手续费收入', 'REVENUE'),
  }
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function respondError(res: ServerResponse, error: unknown): void {
  if (error instanceof InsufficientBalanceError) {
    respond(res, 402, { error: error.name, message: error.message })
    return
  }
  if (error instanceof IdempotencyConflictError || error instanceof IdempotencyInFlightError) {
    respond(res, 409, { error: error.name, message: error.message })
    return
  }
  if (
    error instanceof InvalidTransitionError ||
    error instanceof AlreadyReversedError ||
    error instanceof DuplicateTransferError
  ) {
    respond(res, 409, { error: error.name, message: error.message })
    return
  }
  if (error instanceof InvalidIdempotencyKeyError || error instanceof InvalidEntryError) {
    respond(res, 422, { error: error.name, message: error.message })
    return
  }
  if (error instanceof UnbalancedEntryError) {
    respond(res, 422, { error: error.name, message: error.message, debits: error.debits, credits: error.credits })
    return
  }
  if (error instanceof AccountNotFoundError || error instanceof TransferNotFoundError) {
    respond(res, 404, { error: error.name, message: error.message })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  respond(res, 500, { error: 'InternalError', message })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new InvalidEntryError('请求体超过 1MB')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed: unknown = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidEntryError('请求体必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

function numberField(body: Record<string, unknown>, key: string, fallback?: number): number {
  const value = body[key]
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'number') throw new InvalidEntryError(`字段 ${key} 必须是数字（分）`)
  return value
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.length === 0) throw new InvalidEntryError(`字段 ${key} 必须是非空字符串`)
  return value
}

export function createApp(db: Db): Server {
  const ledger = new Ledger(db)
  const ctx = context(ledger)

  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname.replace(/\/+$/, '') || '/'
        const method = req.method ?? 'GET'

        if (method === 'GET' && (path === '/' || path === '/index.html')) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(UI_HTML)
          return
        }

        if (method === 'GET' && path === '/health') {
          respond(res, 200, { ok: true })
          return
        }

        const statementMatch = /^\/accounts\/([^/]+)\/statement$/.exec(path)
        if (method === 'GET' && statementMatch) {
          const account = ledger.account(decodeURIComponent(statementMatch[1] as string))
          const sideParam = url.searchParams.get('side')
          const side = sideParam === 'DEBIT' || sideParam === 'CREDIT' ? sideParam : undefined
          respond(res, 200, { account, lines: ledger.statement(account.id, side ? { side } : {}) })
          return
        }

        if (method === 'GET' && path.startsWith('/accounts/')) {
          const code = decodeURIComponent(path.slice('/accounts/'.length))
          const account = ledger.account(code)
          respond(res, 200, { account, balance: ledger.balance(account.id), totals: ledger.totals(account.id) })
          return
        }

        if (method === 'POST' && path === '/funding') {
          const body = await readJson(req)
          const amount = numberField(body, 'amount')
          const entry = ledger.post({
            currency: 'CNY',
            postings: [
              { accountId: ctx.reserve.id, side: DEBIT, amount },
              { accountId: ctx.wallet.id, side: CREDIT, amount },
            ],
            memo: '用户入金',
          })
          respond(res, 200, { entryId: entry.id, amount })
          return
        }

        if (method === 'POST' && path === '/transfers') {
          const body = await readJson(req)
          const headerKey = req.headers['idempotency-key']
          const { result, replayed } = pay(db, ledger, {
            transferId: stringField(body, 'transferId'),
            wallet: ctx.wallet,
            merchant: ctx.payable,
            feeAccount: ctx.feeRevenue,
            amount: numberField(body, 'amount'),
            fee: numberField(body, 'fee', 0),
            idempotencyKey: typeof headerKey === 'string' && headerKey.length > 0 ? headerKey : undefined,
          })
          respond(res, 200, { ...result, replayed })
          return
        }

        const settleMatch = /^\/transfers\/([^/]+)\/settle$/.exec(path)
        if (method === 'POST' && settleMatch) {
          const transferId = decodeURIComponent(settleMatch[1] as string)
          await readJson(req)
          const { result, replayed } = settle(db, ledger, {
            transferId,
            merchant: ctx.payable,
            settlementAccount: ctx.reserve,
          })
          respond(res, 200, { ...result, replayed })
          return
        }

        const reverseMatch = /^\/transfers\/([^/]+)\/reverse$/.exec(path)
        if (method === 'POST' && reverseMatch) {
          const transferId = decodeURIComponent(reverseMatch[1] as string)
          const body = await readJson(req)
          const result = reverseTransfer(db, ledger, {
            transferId,
            reason: stringField(body, 'reason'),
          })
          respond(res, 200, result)
          return
        }

        const transferMatch = /^\/transfers\/([^/]+)$/.exec(path)
        if (method === 'GET' && transferMatch) {
          const transferId = decodeURIComponent(transferMatch[1] as string)
          respond(res, 200, { transfer: getTransfer(db, transferId) })
          return
        }

        if (method === 'POST' && path === '/recon') {
          const body = await readJson(req)
          const ledgerLines = body.ledgerLines
          const bankLines = body.bankLines
          if (!Array.isArray(ledgerLines) || !Array.isArray(bankLines)) {
            throw new InvalidEntryError('ledgerLines / bankLines 必须是数组')
          }
          const result = reconcile({
            ledgerLines: ledgerLines as ReconLine[],
            bankLines: bankLines as ReconLine[],
            asOf: typeof body.asOf === 'string' ? body.asOf : undefined,
          })
          respond(res, 200, result)
          return
        }

        respond(res, 404, { error: 'NotFound', message: `${method} ${path}` })
      } catch (error) {
        respondError(res, error)
      }
    })()
  })
}

const thisFile = fileURLToPath(import.meta.url)
if (process.argv[1] === thisFile) {
  const port = Number(process.env.PORT ?? 8787)
  const db = createDb(process.env.DB_PATH ?? ':memory:')
  createApp(db).listen(port, () => {
    console.log(`fengbo-ledger listening on http://localhost:${port}`)
    console.log(`  控制台：http://localhost:${port}/`)
  })
}
