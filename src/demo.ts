/**
 * 演示脚本：把「重试 / 冲突 / 余额不足 / 冲正 / 对账」跑成一条可读的流水线。
 *
 *   node src/demo.ts
 *
 * 全程内存库，可重复执行；末段断言失败会以非 0 退出码结束（当作冒烟测试用）。
 */

import assert from 'node:assert/strict'
import { CREDIT, DEBIT } from './domain/accounts.ts'
import { formatMoney } from './domain/money.ts'
import { Ledger } from './ledger/ledger.ts'
import {
  InsufficientBalanceError,
  TransferNotFoundError,
  getTransfer,
  pay,
  reverseTransfer,
  settle,
  statusHistory,
} from './payments/pay.ts'
import { reconcile } from './recon/reconcile.ts'
import { createDb } from './store/db.ts'

const DAY = 24 * 60 * 60 * 1000
const daysAgo = (days: number): string => new Date(Date.now() - days * DAY).toISOString()
const yuan = (minor: number): string => formatMoney({ minor, currency: 'CNY' })

function heading(text: string): void {
  console.log(`\n【${text}】`)
}

const db = createDb(':memory:')
const ledger = new Ledger(db)

console.log('═══ 借贷账务最小闭环 · 演示 ═══')

// ── 科目 ────────────────────────────────────────────────────────────────
const wallet = ledger.openAccount({ code: '2001', name: '用户钱包', type: 'LIABILITY' })
const payable = ledger.openAccount({ code: '2002', name: '商户待结算', type: 'LIABILITY' })
const reserve = ledger.openAccount({ code: '1002', name: '备付金', type: 'ASSET' })
const feeRevenue = ledger.openAccount({ code: '4001', name: '手续费收入', type: 'REVENUE' })

heading('科目')
for (const account of [reserve, wallet, payable, feeRevenue]) {
  console.log(`  ${account.code}  ${account.name.padEnd(6, '　')} ${account.type}`)
}

// 期初：向备付金户入金 500 元，进入用户钱包
ledger.post({
  currency: 'CNY',
  postings: [
    { accountId: reserve.id, side: DEBIT, amount: 500_00 },
    { accountId: wallet.id, side: CREDIT, amount: 500_00 },
  ],
  memo: '期初入金',
})
console.log(`  钱包初始余额：${yuan(ledger.balance(wallet.id).minor)}`)

// ── 1. 支付 + 重试风暴 ──────────────────────────────────────────────────
heading('支付 TX-A：100.00 元，手续费 0.60 元')
const payDraft = {
  transferId: 'TX-A',
  wallet,
  merchant: payable,
  feeAccount: feeRevenue,
  amount: 100_00,
  fee: 60,
}

const first = pay(db, ledger, payDraft)
console.log(`  第 1 次：entry=${first.result.entryId.slice(0, 8)} replayed=${first.replayed}`)

// 客户端超时重试两次，带同一个幂等键
for (const attempt of [2, 3]) {
  const retry = pay(db, ledger, payDraft)
  console.log(`  第 ${attempt} 次：entry=${retry.result.entryId.slice(0, 8)} replayed=${retry.replayed}`)
}
assert.equal(first.replayed, false)
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get()?.n, 2) // 期初 + 支付

heading('余额（分录只有一笔，说明重试没有二次扣款）')
console.log(`  钱包        ${yuan(ledger.balance(wallet.id).minor)}`)
console.log(`  商户待结算  ${yuan(ledger.balance(payable.id).minor)}`)
console.log(`  手续费收入  ${yuan(ledger.balance(feeRevenue.id).minor)}`)

// ── 2. 同 key 异参 → 冲突 ───────────────────────────────────────────────
heading('同幂等键、不同金额')
try {
  // 同一个幂等键，金额不同 → 必须拒绝，不能当成新的支付
  pay(db, ledger, { ...payDraft, transferId: 'TX-A-BAD', amount: 200_00, idempotencyKey: 'pay:TX-A' })
  console.log('  ❌ 期望冲突，却执行成功')
  process.exitCode = 1
} catch (error) {
  assert.ok(error instanceof Error)
  console.log(`  ✅ 拒绝：${error.name} — ${error.message}`)
}

// ── 3. 余额不足：不留半截状态 ───────────────────────────────────────────
heading('余额不足 TX-OVERDRAFT（10,000.00 元）')
try {
  pay(db, ledger, { ...payDraft, transferId: 'TX-OVERDRAFT', amount: 1_000_000, fee: 0 })
  console.log('  ❌ 期望抛出余额不足')
  process.exitCode = 1
} catch (error) {
  assert.ok(error instanceof InsufficientBalanceError)
  console.log(`  ✅ 拒绝：需要 ${yuan(error.required)}，钱包只有 ${yuan(error.available)}`)
}
assert.throws(() => getTransfer(db, 'TX-OVERDRAFT'), TransferNotFoundError)
console.log('  ✅ 事务回滚：失败请求没有留下支付单，也没有留下幂等键')

// ── 4. 结算出款 ─────────────────────────────────────────────────────────
heading('结算：商户待结算 → 银行备付金户')
const settled = settle(db, ledger, { transferId: 'TX-A', merchant: payable, settlementAccount: reserve })
console.log(`  出款 ${yuan(settled.result.settled)}  状态=${getTransfer(db, 'TX-A').status}`)

// 再造几笔，用于对账演示
const extra: Array<{ id: string; amount: number; fee: number; settledAt: string }> = [
  { id: 'TX-B', amount: 50_00, fee: 30, settledAt: new Date().toISOString() }, // 今天，回单未到 → 在途
  { id: 'TX-C', amount: 2_00, fee: 2, settledAt: daysAgo(5) }, // 5 天前，回单未到 → 追单
  { id: 'TX-D', amount: 1_60, fee: 0, settledAt: new Date().toISOString() }, // 银行回单金额不符
]
for (const item of extra) {
  pay(db, ledger, {
    ...payDraft,
    transferId: item.id,
    amount: item.amount,
    fee: item.fee,
    occurredAt: item.settledAt,
  })
  settle(db, ledger, {
    transferId: item.id,
    merchant: payable,
    settlementAccount: reserve,
    occurredAt: item.settledAt,
  })
}

// ── 5. 冲正 ─────────────────────────────────────────────────────────────
heading('冲正 TX-F（8.00 元，客户申诉）')
pay(db, ledger, { ...payDraft, transferId: 'TX-F', amount: 8_00, fee: 0 })
const before = ledger.balance(wallet.id).minor
const reversal = reverseTransfer(db, ledger, { transferId: 'TX-F', reason: '客户申诉，原路退回' })
const after = ledger.balance(wallet.id).minor
console.log(`  生成冲正分录 ${reversal.reversedEntryIds.length} 笔，钱包 ${yuan(before)} → ${yuan(after)}`)
console.log(`  转账状态：${getTransfer(db, 'TX-F').status}`)
assert.equal(after - before, 8_00)
assert.equal(getTransfer(db, 'TX-F').status, 'REVERSED')

heading('状态留痕（TX-A）')
for (const event of statusHistory(db, 'TX-A')) {
  console.log(`  ${event.from ?? '—'} → ${event.to}  ${event.reason}`)
}

// ── 6. 试算平衡 ─────────────────────────────────────────────────────────
heading('试算平衡')
const trial = ledger.trialBalance()
let totalDebits = 0
let totalCredits = 0
for (const row of trial) {
  totalDebits += row.debits
  totalCredits += row.credits
  if (row.debits === 0 && row.credits === 0) continue
  console.log(`  ${row.code}  借 ${yuan(row.debits).padStart(10)}  贷 ${yuan(row.credits).padStart(10)}`)
}
assert.equal(totalDebits, totalCredits)
console.log(`  合计：借 ${yuan(totalDebits)} = 贷 ${yuan(totalCredits)} ✅`)

// ── 7. 对账 ─────────────────────────────────────────────────────────────
heading('对账：银行回单 vs 账上出款流水')
const ledgerLines = ledger.statement(reserve.id, { side: CREDIT }).map((line) => ({
  externalRef: line.externalRef,
  amount: line.amount,
  occurredAt: line.occurredAt,
}))

const bankLines = [
  { externalRef: 'SETTLE-TX-A', amount: 99_40, occurredAt: new Date().toISOString() },
  // 渠道把同一笔回单推了两次
  { externalRef: 'SETTLE-TX-A', amount: 99_40, occurredAt: new Date().toISOString() },
  // 银行说 1.65，账上 1.60
  { externalRef: 'SETTLE-TX-D', amount: 1_65, occurredAt: new Date().toISOString() },
  // 渠道有、账上没有
  { externalRef: 'SETTLE-TX-E', amount: 30_00, occurredAt: daysAgo(1) },
]

const result = reconcile({ ledgerLines, bankLines, asOf: new Date().toISOString() })

for (const diff of result.diffs) {
  const transit = diff.inTransit ? '（在途）' : ''
  console.log(`  ⚠ ${diff.kind.padEnd(20)} ${diff.externalRef}${transit}`)
  console.log(`      ${diff.suggestion}`)
}
console.log(
  `  账 ${yuan(result.summary.ledgerTotal)} / 银行 ${yuan(result.summary.bankTotal)} / 净差 ${yuan(result.summary.netDifference)}`,
)

assert.equal(result.diffs.length, 5)
assert.equal(result.summary.byKind.DUPLICATE_IN_BANK, 1)
assert.equal(result.summary.byKind.AMOUNT_MISMATCH, 1)
assert.equal(result.summary.byKind.MISSING_IN_LEDGER, 1)
assert.equal(result.summary.byKind.MISSING_IN_BANK, 2)
assert.equal(result.diffs.filter((diff) => diff.inTransit).length, 1)
console.log('  ✅ 五类差异全部识别，其中 1 笔在途未计入异常')

console.log('\n═══ 演示结束（断言全部通过）═══')
