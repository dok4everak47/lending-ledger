/**
 * 黄金端到端场景：一笔真实的借贷业务，从入金走到结算 + 冲正 + 对账。
 *
 * 这是整个 demo 的验收场景——断言都对着业务口径，而不是对着函数返回值：
 * 钱不能凭空出现、不能凭空消失、重放不能重复扣款、冲正必须把账原样抵掉。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CREDIT } from '../src/domain/accounts.ts'
import { getTransfer, pay, reverseTransfer, settle } from '../src/payments/pay.ts'
import { reconcile } from '../src/recon/reconcile.ts'
import { fixture } from './helpers.ts'

test('黄金场景：入金 → 支付 → 结算 → 对账，全程账实相符', () => {
  const { db, ledger, wallet, payable, reserve, feeRevenue } = fixture(1_000_00)

  // 支付 300 元，抽 1.80 手续费
  const payment = pay(db, ledger, {
    transferId: 'TX-GOLD-1',
    wallet,
    merchant: payable,
    feeAccount: feeRevenue,
    amount: 300_00,
    fee: 1_80,
  })

  assert.equal(payment.replayed, false)
  assert.equal(ledger.balance(wallet.id).minor, 700_00)
  assert.equal(ledger.balance(payable.id).minor, 298_20)
  assert.equal(ledger.balance(feeRevenue.id).minor, 1_80)

  settle(db, ledger, { transferId: 'TX-GOLD-1', merchant: payable, settlementAccount: reserve })

  // 结算后：待结算清零，备付金户减少 298.20（钱真的出去了）
  assert.equal(ledger.balance(payable.id).minor, 0)
  assert.equal(ledger.balance(reserve.id).minor, 1_000_00 - 298_20)

  // 全科目不得为负：资产不能透支、负债不能反向
  for (const row of ledger.trialBalance()) {
    assert.ok(row.minor >= 0, `${row.code} 余额为负：${row.minor}`)
  }

  // 试算平衡
  const trial = ledger.trialBalance()
  assert.equal(
    trial.reduce((sum, row) => sum + row.debits, 0),
    trial.reduce((sum, row) => sum + row.credits, 0),
  )

  // 对账：账上出款流水 vs 干净回单，应当完全匹配
  const ledgerLines = ledger.statement(reserve.id, { side: CREDIT }).map((line) => ({
    externalRef: line.externalRef,
    amount: line.amount,
    occurredAt: line.occurredAt,
  }))
  const result = reconcile({ ledgerLines, bankLines: ledgerLines.map((line) => ({ ...line })) })
  assert.equal(result.reconciled, true)
  assert.equal(result.summary.matchedCount, 1)

  // 冲正整单：商户待结算回到 0，状态走到终态
  reverseTransfer(db, ledger, { transferId: 'TX-GOLD-1', reason: '黄金场景回滚' })
  assert.equal(ledger.balance(payable.id).minor, 0)
  assert.equal(getTransfer(db, 'TX-GOLD-1').status, 'REVERSED')
})

test('黄金场景：同一笔支付重放 100 次，账簿只有一笔分录', () => {
  const { db, ledger, wallet, payable, feeRevenue } = fixture(1_000_00)
  const request = {
    transferId: 'TX-GOLD-2',
    wallet,
    merchant: payable,
    feeAccount: feeRevenue,
    amount: 100_00,
    fee: 60,
  }

  const first = pay(db, ledger, request)
  for (let attempt = 0; attempt < 99; attempt += 1) {
    const again = pay(db, ledger, request)
    assert.equal(again.replayed, true)
    assert.equal(again.result.entryId, first.result.entryId)
  }

  const entries = db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as { n: number }
  assert.equal(entries.n, 2) // 期初入金 + 支付
  assert.equal(ledger.balance(wallet.id).minor, 900_00)
  assert.equal(ledger.balance(feeRevenue.id).minor, 60)
})

test('黄金场景：余额不足的支付不留任何痕迹', () => {
  const { db, ledger, wallet, payable, feeRevenue } = fixture(100_00)

  assert.throws(() =>
    pay(db, ledger, {
      transferId: 'TX-GOLD-3',
      wallet,
      merchant: payable,
      feeAccount: feeRevenue,
      amount: 200_00,
      fee: 0,
    }),
  )

  const count = (table: string): number => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    return row.n
  }

  assert.equal(count('journal_entries'), 1) // 只有期初入金
  assert.equal(count('idempotency_keys'), 0) // 幂等键随事务回滚
  assert.equal(count('transfers'), 0) // 支付单也没留下
  assert.equal(ledger.balance(wallet.id).minor, 100_00)
})
