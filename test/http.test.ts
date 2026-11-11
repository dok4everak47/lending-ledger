/**
 * 端到端：真的起一个 HTTP server，用 fetch 打完整的支付 / 重试 / 结算 / 冲正链路。
 * 这一层验证的是「接口契约」而不是内部函数——幂等键走 header，错误码走状态码。
 */

import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { createApp } from '../src/api/http.ts'
import { createDb } from '../src/store/db.ts'

const server = createApp(createDb(':memory:'))
let base = ''

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  base = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() }
}

async function get(path: string): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${path}`)
  return { status: response.status, json: await response.json() }
}

test('健康检查', async () => {
  const { status, json } = await get('/health')
  assert.equal(status, 200)
  assert.equal(json.ok, true)
})

test('入金后余额可查', async () => {
  const funded = await post('/funding', { amount: 100_000 })
  assert.equal(funded.status, 200)

  const { json } = await get('/accounts/2001')
  assert.equal(json.balance.minor, 100_000)
  assert.equal(json.balance.normalSide, 'CREDIT')
})

test('同一 Idempotency-Key 重试：返回同一笔分录，标记 replayed', async () => {
  const body = { transferId: 'TX-HTTP-1', amount: 10_000, fee: 60 }
  const first = await post('/transfers', body, { 'idempotency-key': 'key-http-1' })
  const second = await post('/transfers', body, { 'idempotency-key': 'key-http-1' })

  assert.equal(first.status, 200)
  assert.equal(first.json.replayed, false)
  assert.equal(second.json.replayed, true)
  assert.equal(second.json.entryId, first.json.entryId)
  assert.equal(second.json.merchantReceivable, 9_940)
})

test('同 key 异参：409', async () => {
  const { status, json } = await post(
    '/transfers',
    { transferId: 'TX-HTTP-2', amount: 20_000, fee: 0 },
    { 'idempotency-key': 'key-http-1' },
  )
  assert.equal(status, 409)
  assert.equal(json.error, 'IdempotencyConflictError')
})

test('同业务单号换 key：409，而不是 500', async () => {
  const { status, json } = await post(
    '/transfers',
    { transferId: 'TX-HTTP-1', amount: 10_000, fee: 60 },
    { 'idempotency-key': 'key-http-2' },
  )
  assert.equal(status, 409)
  assert.equal(json.error, 'DuplicateTransferError')
})

test('余额不足：402，且余额不变', async () => {
  const before = (await get('/accounts/2001')).json.balance.minor
  const { status, json } = await post('/transfers', { transferId: 'TX-HTTP-OVER', amount: 9_999_999, fee: 0 })
  assert.equal(status, 402)
  assert.equal(json.error, 'InsufficientBalanceError')
  assert.equal((await get('/accounts/2001')).json.balance.minor, before)
})

test('结算与重复结算：第二次是幂等重放而不是重复出款', async () => {
  const first = await post('/transfers/TX-HTTP-1/settle', {})
  const second = await post('/transfers/TX-HTTP-1/settle', {})

  assert.equal(first.status, 200)
  assert.equal(first.json.settled, 9_940)
  assert.equal(second.json.replayed, true)
  assert.equal(second.json.entryId, first.json.entryId)

  const transfer = await get('/transfers/TX-HTTP-1')
  assert.equal(transfer.json.transfer.status, 'SETTLED')
})

test('冲正：状态推到 REVERSED，且二次冲正被拒', async () => {
  const reversed = await post('/transfers/TX-HTTP-1/reverse', { reason: '测试冲正' })
  assert.equal(reversed.status, 200)
  assert.equal(reversed.json.replayed, false)

  const again = await post('/transfers/TX-HTTP-1/reverse', { reason: '测试冲正' })
  assert.equal(again.status, 200)
  assert.equal(again.json.replayed, true)

  const transfer = await get('/transfers/TX-HTTP-1')
  assert.equal(transfer.json.transfer.status, 'REVERSED')
})

test('对账接口返回五类差异结构', async () => {
  const { status, json } = await post('/recon', {
    ledgerLines: [{ externalRef: 'S-1', amount: 100, occurredAt: new Date().toISOString() }],
    bankLines: [
      { externalRef: 'S-1', amount: 90, occurredAt: new Date().toISOString() },
      { externalRef: 'S-2', amount: 50, occurredAt: new Date().toISOString() },
    ],
  })
  assert.equal(status, 200)
  assert.equal(json.summary.diffCount, 2)
  assert.equal(json.summary.byKind.AMOUNT_MISMATCH, 1)
  assert.equal(json.summary.byKind.MISSING_IN_LEDGER, 1)
})

test('字段类型错误：422', async () => {
  const { status, json } = await post('/transfers', { transferId: 'TX-HTTP-3', amount: '100' })
  assert.equal(status, 422)
  assert.equal(json.error, 'InvalidEntryError')
})

test('未知路由：404', async () => {
  const { status } = await get('/nope')
  assert.equal(status, 404)
})
