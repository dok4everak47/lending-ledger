/**
 * 并发工作进程：模拟客户端超时后同时重试同一笔支付。
 *
 * 由 test/concurrency.test.ts fork 起来，通过 IPC 回报结果。
 * 这里是真进程、真文件库——不是同线程里的假并发。
 */

import { Ledger } from '../../src/ledger/ledger.ts'
import { pay } from '../../src/payments/pay.ts'
import { openDb } from '../../src/store/db.ts'

const [dbPath, key, transferId] = process.argv.slice(2)

if (!dbPath || !key || !transferId) {
  console.error('用法：pay-worker.ts <dbPath> <idempotencyKey> <transferId>')
  process.exit(2)
}

const db = openDb(dbPath)
const ledger = new Ledger(db)

try {
  const { result, replayed } = pay(db, ledger, {
    transferId,
    wallet: ledger.account('2001'),
    merchant: ledger.account('2002'),
    feeAccount: ledger.account('4001'),
    amount: 100_00,
    fee: 60,
  })
  process.send?.({ ok: true, replayed, entryId: result.entryId, transferId: result.transferId })
} catch (error) {
  process.send?.({ ok: false, error: error instanceof Error ? error.name : String(error) })
} finally {
  db.close()
}
