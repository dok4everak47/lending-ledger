/**
 * 存储层：node:sqlite（Node 24 内置，无需安装依赖，评审时 clone 下来就能跑）。
 *
 * 事务用 BEGIN IMMEDIATE：一上来就拿写锁，避免「先读后写」在并发下变成
 * 幽灵写（SQLite 的默认 DEFERRED 会在升级锁时才失败，错误更晚、更难定位）。
 */

import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export type Db = DatabaseSync

const SCHEMA_PATH = new URL('./schema.sql', import.meta.url)

/** 事务嵌套深度：内层 withTx 直接复用外层事务，不重复 BEGIN。 */
const txDepth = new WeakMap<Db, number>()

export function openDb(location = ':memory:'): Db {
  const db = new DatabaseSync(location)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

export function migrate(db: Db): void {
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'))
}

/** 开库 + 建表，测试与 demo 的默认入口。 */
export function createDb(location = ':memory:'): Db {
  const db = openDb(location)
  migrate(db)
  return db
}

export function withTx<T>(db: Db, work: () => T): T {
  const depth = txDepth.get(db) ?? 0
  if (depth > 0) {
    txDepth.set(db, depth + 1)
    try {
      return work()
    } finally {
      txDepth.set(db, depth)
    }
  }

  db.exec('BEGIN IMMEDIATE')
  txDepth.set(db, 1)
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    txDepth.set(db, 0)
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}
