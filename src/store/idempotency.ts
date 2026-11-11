/**
 * 幂等层：把「重试」从业务问题变成存储问题。
 *
 * 支付链路上的重试几乎必然发生（网络超时、客户端超时重发、网关重投），
 * 所以幂等键不能放在业务代码里「先查再写」——那是竞态。
 * 这里的做法：
 *   - 唯一索引即锁：INSERT 成功者获得执行权，失败者按 fingerprint 判断是「重放」还是「冲突」；
 *   - 两态：IN_PROGRESS / COMPLETED，并发同 key 的后来者拿到 409，而不是重复扣款；
 *   - 结果整体落库（response），重放时原样返回，调用方无法区分首调与重放（这正是幂等的定义）。
 */

import { fingerprint } from '../domain/journal.ts'
import type { Db } from './db.ts'
import { nowIso, withTx } from './db.ts'

export class InvalidIdempotencyKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidIdempotencyKeyError'
  }
}

export class IdempotencyConflictError extends Error {
  readonly key: string

  constructor(key: string) {
    super(`幂等键 ${key} 已被用于另一个请求体（同 key 异参）`)
    this.name = 'IdempotencyConflictError'
    this.key = key
  }
}

export class IdempotencyInFlightError extends Error {
  readonly key: string

  constructor(key: string) {
    super(`幂等键 ${key} 的请求正在处理中，请勿并发重试`)
    this.name = 'IdempotencyInFlightError'
    this.key = key
  }
}

export interface IdempotentResult<T> {
  value: T
  replayed: boolean
  key: string
}

export interface IdempotentOptions {
  key: string
  scope: string
  request: unknown
  now?: string
}

type KeyRow = {
  fingerprint: string
  status: 'IN_PROGRESS' | 'COMPLETED'
  response: string | null
}

export function assertIdempotencyKey(key: string): string {
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new InvalidIdempotencyKeyError('缺少幂等键')
  }
  if (key.length > 255) {
    throw new InvalidIdempotencyKeyError('幂等键长度不得超过 255')
  }
  return key
}

/**
 * 执行一段副作用，并用幂等键去重。
 * `work` 必须能在同一事务内完成（写账、改状态），否则会出现「键已完成但账没落」的裂缝。
 */
export function executeIdempotent<T>(
  db: Db,
  options: IdempotentOptions,
  work: () => T,
): IdempotentResult<T> {
  const key = assertIdempotencyKey(options.key)
  const requestFingerprint = fingerprint({ scope: options.scope, request: options.request })

  return withTx(db, () => {
    const existing = db
      .prepare('SELECT fingerprint, status, response FROM idempotency_keys WHERE key = ?')
      .get(key) as KeyRow | undefined

    if (existing) {
      if (existing.fingerprint !== requestFingerprint) throw new IdempotencyConflictError(key)
      if (existing.status === 'COMPLETED') {
        return {
          value: JSON.parse(existing.response ?? 'null') as T,
          replayed: true,
          key,
        }
      }
      throw new IdempotencyInFlightError(key)
    }

    const createdAt = options.now ?? nowIso()
    db.prepare(
      `INSERT INTO idempotency_keys (key, scope, fingerprint, status, created_at, updated_at)
       VALUES (?, ?, ?, 'IN_PROGRESS', ?, ?)`,
    ).run(key, options.scope, requestFingerprint, createdAt, createdAt)

    const value = work()

    db.prepare(
      `UPDATE idempotency_keys SET status = 'COMPLETED', response = ?, updated_at = ? WHERE key = ?`,
    ).run(JSON.stringify(value), nowIso(), key)

    return { value, replayed: false, key }
  })
}
