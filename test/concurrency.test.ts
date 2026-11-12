/**
 * 真并发测试：6 个进程同时用同一把幂等键重试同一笔支付。
 *
 * 为什么值得单独写：单元测试里的「重放」是顺序的，而线上事故来自同时到达。
 * 这里用真进程 + 真文件库，靠 SQLite 的 BEGIN IMMEDIATE + busy_timeout 串行化，
 * 断言的是业务口径——钱只扣一次、分录只有一笔、状态只推一次。
 */

import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DEBIT } from '../src/domain/accounts.ts'
import { Ledger } from '../src/ledger/ledger.ts'
import { createDb } from '../src/store/db.ts'

const WORKER = new URL('./fixtures/pay-worker.ts', import.meta.url)
const WORKERS = 6
const dir = mkdtempSync(join(tmpdir(), 'lending-ledger-concurrency-'))

after(() => rmSync(dir, { recursive: true, force: true }))

type WorkerReport = { ok: boolean; replayed?: boolean; entryId?: string; error?: string }

function runWorker(dbPath: string, key: string, transferId: string): Promise<WorkerReport> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = fork(WORKER, [dbPath, key, transferId], { stdio: 'inherit' })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('工作进程超时未返回'))
    }, 20_000)

    child.once('message', (message) => {
      clearTimeout(timer)
      resolve(message as WorkerReport)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timer)
        reject(new Error(`工作进程异常退出：${code}`))
      }
    })
  })
}

function seedDatabase(dbPath: string): void {
  const db = createDb(dbPath)
  const ledger = new Ledger(db)
  const wallet = ledger.openAccount({ code: '2001', name: '用户钱包', type: 'LIABILITY' })
  ledger.openAccount({ code: '2002', name: '商户待结算', type: 'LIABILITY' })
  ledger.openAccount({ code: '4001', name: '手续费收入', type: 'REVENUE' })
  const reserve = ledger.openAccount({ code: '1002', name: '备付金', type: 'ASSET' })

  ledger.post({
    currency: 'CNY',
    postings: [
      { accountId: reserve.id, side: DEBIT, amount: 1_000_00 },
      { accountId: wallet.id, side: 'CREDIT', amount: 1_000_00 },
    ],
    memo: '期初入金',
  })
  db.close()
}

test('6 个进程同时重试同一笔支付：只扣一次款', async () => {
  const dbPath = join(dir, 'concurrent.db')
  seedDatabase(dbPath)

  const reports = await Promise.all(
    Array.from({ length: WORKERS }, () => runWorker(dbPath, 'pay-concurrent-1', 'TX-CONCURRENT-1')),
  )

  const failures = reports.filter((report) => !report.ok)
  assert.deepEqual(
    failures.map((report) => report.error),
    [],
    '所有并发重试都应当成功返回（要么首次执行，要么重放）',
  )

  const executed = reports.filter((report) => report.replayed === false)
  const replayed = reports.filter((report) => report.replayed === true)

  assert.equal(executed.length, 1, '有且只有一个进程真正执行了扣款')
  assert.equal(replayed.length, WORKERS - 1, '其余全部是重放')
  assert.equal(new Set(reports.map((report) => report.entryId)).size, 1, '所有进程拿到同一笔分录')

  const db = createDb(dbPath)
  try {
    const entries = db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as { n: number }
    const keys = db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get() as { n: number }
    const transfers = db.prepare('SELECT COUNT(*) AS n FROM transfers').get() as { n: number }
    const wallet = db.prepare("SELECT id FROM accounts WHERE code = '2001'").get() as { id: string }

    assert.equal(entries.n, 2, '期初入金 + 一笔支付，不能多')
    assert.equal(keys.n, 1)
    assert.equal(transfers.n, 1)

    const ledger = new Ledger(db)
    assert.equal(ledger.balance(wallet.id).minor, 1_000_00 - 100_00, '钱包只被扣一次')

    const trial = ledger.trialBalance()
    assert.equal(
      trial.reduce((sum, row) => sum + row.debits, 0),
      trial.reduce((sum, row) => sum + row.credits, 0),
      '并发之后仍然借贷平衡',
    )
  } finally {
    db.close()
  }
})
