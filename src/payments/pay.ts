/**
 * 业务编排：钱包支付 → 商户待结算 → 结算出款。
 *
 * 这一层才出现「业务语义」（谁付谁、抽多少手续费），会计语义留给 ledger。
 * 每一步都同时做三件事：状态机校验、写分录、记幂等键——三者必须在同一事务里，
 * 否则就会出现「钱扣了但状态没变」这种最难查的不一致。
 */

import type { Account } from '../domain/accounts.ts'
import { CREDIT, DEBIT } from '../domain/accounts.ts'
import type { PostingInput } from '../domain/journal.ts'
import { InvalidEntryError } from '../domain/journal.ts'
import type { Currency } from '../domain/money.ts'
import type { TransferStatus } from '../domain/state-machine.ts'
import { assertTransition } from '../domain/state-machine.ts'
import { Ledger } from '../ledger/ledger.ts'
import type { Db } from '../store/db.ts'
import { nowIso, withTx } from '../store/db.ts'
import { executeIdempotent } from '../store/idempotency.ts'

export class InsufficientBalanceError extends Error {
  readonly accountId: string
  readonly required: number
  readonly available: number

  constructor(accountId: string, required: number, available: number) {
    super(`余额不足：需要 ${required}，可用 ${available}`)
    this.name = 'InsufficientBalanceError'
    this.accountId = accountId
    this.required = required
    this.available = available
  }
}

export class DuplicateTransferError extends Error {
  readonly transferId: string

  constructor(transferId: string) {
    super(`支付单 ${transferId} 已存在：同一业务单号不能重复发起`)
    this.name = 'DuplicateTransferError'
    this.transferId = transferId
  }
}

export class TransferNotFoundError extends Error {
  constructor(transferId: string) {
    super(`转账单不存在：${transferId}`)
    this.name = 'TransferNotFoundError'
  }
}

export interface Transfer {
  id: string
  status: TransferStatus
  currency: string
  amount: number
  fee: number
  walletId: string
  merchantId: string
  updatedAt: string
}

export interface PayRequest {
  /** 业务单号，同时作为对账匹配键 externalRef */
  transferId: string
  wallet: Account
  merchant: Account
  feeAccount: Account
  amount: number
  fee: number
  occurredAt?: string
  /** 客户端幂等键；不传则按业务单号生成 */
  idempotencyKey?: string
}

export interface PayResult {
  transferId: string
  status: TransferStatus
  entryId: string
  amount: number
  fee: number
  merchantReceivable: number
}

type TransferRow = {
  id: string
  status: string
  currency: string
  amount: number
  fee: number
  wallet_id: string
  merchant_id: string
  updated_at: string
}

function toTransfer(row: TransferRow): Transfer {
  return {
    id: row.id,
    status: row.status as TransferStatus,
    currency: row.currency,
    amount: row.amount,
    fee: row.fee,
    walletId: row.wallet_id,
    merchantId: row.merchant_id,
    updatedAt: row.updated_at,
  }
}

export function getTransfer(db: Db, transferId: string): Transfer {
  const row = db.prepare('SELECT * FROM transfers WHERE id = ?').get(transferId) as
    | TransferRow
    | undefined
  if (!row) throw new TransferNotFoundError(transferId)
  return toTransfer(row)
}

function recordStatus(
  db: Db,
  transferId: string,
  from: TransferStatus | null,
  to: TransferStatus,
  reason = '',
): void {
  db.prepare(
    'INSERT INTO transfer_status_events (transfer_id, from_status, to_status, at, reason) VALUES (?, ?, ?, ?, ?)',
  ).run(transferId, from, to, nowIso(), reason)
  db.prepare('UPDATE transfers SET status = ?, updated_at = ? WHERE id = ?').run(to, nowIso(), transferId)
}

/** 推进状态：先校验迁移合法，再落库。非法迁移抛错，事务回滚。 */
function advance(db: Db, transferId: string, to: TransferStatus, reason = ''): void {
  const current = getTransfer(db, transferId)
  assertTransition(current.status, to)
  recordStatus(db, transferId, current.status, to, reason)
}

/**
 * 支付：钱包扣款 → 商户待结算 + 手续费收入。
 * 幂等键落在 `pay:<transferId>`，重复请求返回首次结果，不会二次扣款。
 */
export function pay(db: Db, ledger: Ledger, request: PayRequest): { result: PayResult; replayed: boolean } {
  if (!Number.isSafeInteger(request.amount) || request.amount <= 0) {
    throw new InvalidEntryError('支付金额必须是正整数（分）')
  }
  if (!Number.isSafeInteger(request.fee) || request.fee < 0 || request.fee >= request.amount) {
    throw new InvalidEntryError('手续费必须 >= 0 且小于支付金额')
  }

  const key = request.idempotencyKey ?? `pay:${request.transferId}`
  const receivable = request.amount - request.fee

  const executed = executeIdempotent<PayResult>(
    db,
    {
      key,
      scope: 'payment.pay',
      request: {
        transferId: request.transferId,
        walletId: request.wallet.id,
        merchantId: request.merchant.id,
        amount: request.amount,
        fee: request.fee,
      },
    },
    () => {
      const occurredAt = request.occurredAt ?? nowIso()

      // 换一个幂等键、同一个业务单号再打一次，也必须被挡住（业务键唯一性）
      if (db.prepare('SELECT 1 AS hit FROM transfers WHERE id = ?').get(request.transferId)) {
        throw new DuplicateTransferError(request.transferId)
      }

      db.prepare(
        `INSERT INTO transfers (id, status, currency, amount, fee, wallet_id, merchant_id, updated_at)
         VALUES (?, 'CREATED', ?, ?, ?, ?, ?, ?)`,
      ).run(
        request.transferId,
        request.wallet.currency,
        request.amount,
        request.fee,
        request.wallet.id,
        request.merchant.id,
        occurredAt,
      )
      recordStatus(db, request.transferId, null, 'CREATED', '支付单创建')

      // 余额校验放在事务内、状态推进之前：宁可停在 AUTHORIZED 失败，也不要写出透支分录
      const walletBalance = ledger.balance(request.wallet.id).minor
      if (walletBalance < request.amount) {
        advance(db, request.transferId, 'FAILED', '钱包余额不足')
        throw new InsufficientBalanceError(request.wallet.id, request.amount, walletBalance)
      }
      advance(db, request.transferId, 'AUTHORIZED', '余额校验通过')

      const postings: PostingInput[] = [
        { accountId: request.wallet.id, side: DEBIT, amount: request.amount },
        { accountId: request.merchant.id, side: CREDIT, amount: receivable },
        { accountId: request.feeAccount.id, side: CREDIT, amount: request.fee },
      ].filter((posting) => posting.amount > 0)

      const entry = ledger.post({
        currency: request.wallet.currency as Currency,
        postings,
        memo: `支付 ${request.transferId}`,
        externalRef: request.transferId,
        transferId: request.transferId,
        occurredAt,
      })

      advance(db, request.transferId, 'POSTED', `分录 ${entry.id}`)

      return {
        transferId: request.transferId,
        status: 'POSTED' as const,
        entryId: entry.id,
        amount: request.amount,
        fee: request.fee,
        merchantReceivable: receivable,
      }
    },
  )

  return { result: executed.value, replayed: executed.replayed }
}

/**
 * 结算：把商户待结算款打到银行备付金户（我们在银行的存款户）。
 * externalRef 用 `SETTLE-<transferId>`，与银行回单的对账匹配键对齐。
 */
export function settle(
  db: Db,
  ledger: Ledger,
  request: {
    transferId: string
    merchant: Account
    settlementAccount: Account
    occurredAt?: string
    idempotencyKey?: string
  },
): { result: { transferId: string; status: TransferStatus; entryId: string; settled: number }; replayed: boolean } {
  const key = request.idempotencyKey ?? `settle:${request.transferId}`

  const executed = executeIdempotent(
    db,
    { key, scope: 'payment.settle', request: { transferId: request.transferId } },
    () => {
      const transfer = getTransfer(db, request.transferId)
      if (transfer.status !== 'POSTED') {
        throw new InvalidEntryError(`只有 POSTED 的转账可以结算，当前 ${transfer.status}`)
      }

      const settled = transfer.amount - transfer.fee
      const occurredAt = request.occurredAt ?? nowIso()

      const entry = ledger.post({
        currency: transfer.currency as Currency,
        postings: [
          { accountId: request.merchant.id, side: DEBIT, amount: settled },
          { accountId: request.settlementAccount.id, side: CREDIT, amount: settled },
        ],
        memo: `结算 ${request.transferId}`,
        externalRef: `SETTLE-${request.transferId}`,
        transferId: request.transferId,
        occurredAt,
      })

      advance(db, request.transferId, 'SETTLED', `结算分录 ${entry.id}`)

      return { transferId: request.transferId, status: 'SETTLED' as const, entryId: entry.id, settled }
    },
  )

  return { result: executed.value, replayed: executed.replayed }
}

/**
 * 冲正：把该转账名下所有未冲正分录逐笔反向冲销，状态推到 REVERSED。
 * 不改原分录——这是审计要求，也是「账可以错，但不能改」的行业惯例。
 */
export function reverseTransfer(
  db: Db,
  ledger: Ledger,
  request: { transferId: string; reason: string; idempotencyKey?: string },
): { reversedEntryIds: string[]; replayed: boolean } {
  const key = request.idempotencyKey ?? `reverse:${request.transferId}`

  const executed = executeIdempotent(
    db,
    { key, scope: 'payment.reverse', request: { transferId: request.transferId, reason: request.reason } },
    () => {
      const transfer = getTransfer(db, request.transferId)
      if (transfer.status === 'REVERSED') {
        throw new InvalidEntryError(`转账 ${request.transferId} 已冲正`)
      }

      const reversed: string[] = []
      for (const entry of ledger.entriesByTransfer(request.transferId)) {
        if (entry.reversalOf) continue
        if (ledger.findReversal(entry.id)) continue
        const reversal = ledger.reverse(entry.id, { memo: `冲正 ${request.transferId}：${request.reason}` })
        reversed.push(reversal.id)
      }

      withTx(db, () => advance(db, request.transferId, 'REVERSED', request.reason))
      return { reversedEntryIds: reversed, replayed: false }
    },
  )

  return { reversedEntryIds: executed.value.reversedEntryIds, replayed: executed.replayed }
}

export function statusHistory(
  db: Db,
  transferId: string,
): Array<{ from: string | null; to: string; at: string; reason: string }> {
  return db
    .prepare(
      'SELECT from_status AS "from", to_status AS "to", at, reason FROM transfer_status_events WHERE transfer_id = ? ORDER BY id',
    )
    .all(transferId) as Array<{ from: string | null; to: string; at: string; reason: string }>
}
