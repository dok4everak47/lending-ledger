import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  IdempotencyConflictError,
  IdempotencyInFlightError,
  InvalidIdempotencyKeyError,
  executeIdempotent,
} from '../src/store/idempotency.ts'
import { fingerprint } from '../src/domain/journal.ts'
import { fixture } from './helpers.ts'
import { nowIso } from '../src/store/db.ts'

test('同一个 key + 同一个请求体：只执行一次，第二次原样重放', () => {
  const { db } = fixture(0)
  let executions = 0
  const work = (): { receipt: string } => {
    executions += 1
    return { receipt: `R-${executions}` }
  }
  const request = { amount: 100, to: 'merchant-1' }

  const first = executeIdempotent(db, { key: 'k-1', scope: 'pay', request }, work)
  const second = executeIdempotent(db, { key: 'k-1', scope: 'pay', request }, work)

  assert.equal(executions, 1)
  assert.equal(first.replayed, false)
  assert.equal(second.replayed, true)
  assert.deepEqual(second.value, first.value)
})

test('同一个 key + 不同请求体：判冲突，绝不静默执行', () => {
  const { db } = fixture(0)
  executeIdempotent(db, { key: 'k-2', scope: 'pay', request: { amount: 100 } }, () => 'ok')
  assert.throws(
    () => executeIdempotent(db, { key: 'k-2', scope: 'pay', request: { amount: 200 } }, () => 'ok'),
    IdempotencyConflictError,
  )
})

test('不同 scope 用同一 key 也视为冲突（key 是全局唯一资源）', () => {
  const { db } = fixture(0)
  executeIdempotent(db, { key: 'k-3', scope: 'pay', request: { amount: 100 } }, () => 'ok')
  assert.throws(
    () => executeIdempotent(db, { key: 'k-3', scope: 'refund', request: { amount: 100 } }, () => 'ok'),
    IdempotencyConflictError,
  )
})

test('处理中的同一个 key：返回 409 语义，而不是并发执行', () => {
  const { db } = fixture(0)
  db.prepare(
    `INSERT INTO idempotency_keys (key, scope, fingerprint, status, created_at, updated_at)
     VALUES (?, ?, ?, 'IN_PROGRESS', ?, ?)`,
  ).run('k-4', 'pay', 'irrelevant', nowIso(), nowIso())

  // 指纹不同会先撞冲突，所以这里构造一个指纹相同、但仍在 IN_PROGRESS 的行
  db.prepare('UPDATE idempotency_keys SET fingerprint = ? WHERE key = ?').run(
    fingerprint({ scope: 'pay', request: { amount: 100 } }),
    'k-4',
  )

  assert.throws(
    () => executeIdempotent(db, { key: 'k-4', scope: 'pay', request: { amount: 100 } }, () => 'ok'),
    IdempotencyInFlightError,
  )
})

test('业务执行失败时，幂等键一并回滚：重试会真的重新执行', () => {
  const { db } = fixture(0)
  let attempts = 0
  const work = (): string => {
    attempts += 1
    if (attempts === 1) throw new Error('下游超时')
    return 'done'
  }

  assert.throws(() => executeIdempotent(db, { key: 'k-5', scope: 'pay', request: {} }, work), /下游超时/)
  const retry = executeIdempotent(db, { key: 'k-5', scope: 'pay', request: {} }, work)

  assert.equal(retry.value, 'done')
  assert.equal(retry.replayed, false)
  assert.equal(attempts, 2)
})

test('幂等键必填且有长度上限', () => {
  const { db } = fixture(0)
  assert.throws(
    () => executeIdempotent(db, { key: '  ', scope: 'pay', request: {} }, () => 'ok'),
    InvalidIdempotencyKeyError,
  )
  assert.throws(
    () => executeIdempotent(db, { key: 'x'.repeat(256), scope: 'pay', request: {} }, () => 'ok'),
    InvalidIdempotencyKeyError,
  )
})
