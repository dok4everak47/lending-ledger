import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reconcile } from '../src/recon/reconcile.ts'

const TODAY = '2026-11-11T10:00:00.000Z'
const TWO_DAYS_AGO = '2026-11-09T10:00:00.000Z'
const FIVE_DAYS_AGO = '2026-11-06T10:00:00.000Z'

test('账与回单一致：完全匹配，无差异', () => {
  const result = reconcile({
    ledgerLines: [{ externalRef: 'A', amount: 100, occurredAt: TODAY }],
    bankLines: [{ externalRef: 'A', amount: 100, occurredAt: TODAY }],
    asOf: TODAY,
  })

  assert.equal(result.reconciled, true)
  assert.equal(result.matched.length, 1)
  assert.equal(result.diffs.length, 0)
  assert.equal(result.summary.netDifference, 0)
})

test('金额不符：单独归类，并给出分差', () => {
  const result = reconcile({
    ledgerLines: [{ externalRef: 'A', amount: 100, occurredAt: TODAY }],
    bankLines: [{ externalRef: 'A', amount: 95, occurredAt: TODAY }],
    asOf: TODAY,
  })

  assert.equal(result.diffs[0]?.kind, 'AMOUNT_MISMATCH')
  assert.equal(result.diffs[0]?.ledgerAmount, 100)
  assert.equal(result.diffs[0]?.bankAmount, 95)
  assert.match(result.diffs[0]?.suggestion ?? '', /差异 5 分/)
  assert.equal(result.summary.byKind.AMOUNT_MISMATCH, 1)
})

test('账有单无：T+1 内算在途，超窗算异常', () => {
  const inTransit = reconcile({
    ledgerLines: [{ externalRef: 'A', amount: 100, occurredAt: TODAY }],
    bankLines: [],
    asOf: TODAY,
    inTransitWindowDays: 1,
  })
  assert.equal(inTransit.diffs[0]?.kind, 'MISSING_IN_BANK')
  assert.equal(inTransit.diffs[0]?.inTransit, true)

  const overdue = reconcile({
    ledgerLines: [{ externalRef: 'B', amount: 100, occurredAt: FIVE_DAYS_AGO }],
    bankLines: [],
    asOf: TODAY,
    inTransitWindowDays: 1,
  })
  assert.equal(overdue.diffs[0]?.kind, 'MISSING_IN_BANK')
  assert.equal(overdue.diffs[0]?.inTransit, false)
  assert.equal(overdue.diffs[0]?.ageDays, 5)
  assert.match(overdue.diffs[0]?.suggestion ?? '', /追单/)
})

test('单有账无：必须补记，不能被当成在途', () => {
  const result = reconcile({
    ledgerLines: [],
    bankLines: [{ externalRef: 'C', amount: 300, occurredAt: TWO_DAYS_AGO }],
    asOf: TODAY,
  })
  assert.equal(result.diffs[0]?.kind, 'MISSING_IN_LEDGER')
  assert.equal(result.diffs[0]?.inTransit, false)
  assert.match(result.diffs[0]?.suggestion ?? '', /补记/)
})

test('渠道重复回单与账内重复入账分别归类', () => {
  const bankDup = reconcile({
    ledgerLines: [{ externalRef: 'D', amount: 100, occurredAt: TODAY }],
    bankLines: [
      { externalRef: 'D', amount: 100, occurredAt: TODAY },
      { externalRef: 'D', amount: 100, occurredAt: TODAY },
    ],
    asOf: TODAY,
  })
  assert.equal(bankDup.diffs[0]?.kind, 'DUPLICATE_IN_BANK')

  const ledgerDup = reconcile({
    ledgerLines: [
      { externalRef: 'E', amount: 100, occurredAt: TODAY },
      { externalRef: 'E', amount: 100, occurredAt: TODAY },
    ],
    bankLines: [{ externalRef: 'E', amount: 100, occurredAt: TODAY }],
    asOf: TODAY,
  })
  assert.equal(ledgerDup.diffs[0]?.kind, 'DUPLICATE_IN_LEDGER')
})

test('总量轧平但仍有差异时，reconciled 必须为 false', () => {
  // 一笔多记 100、一笔少记 100，总额相同，差异不能因此被隐藏
  const result = reconcile({
    ledgerLines: [
      { externalRef: 'A', amount: 200, occurredAt: TODAY },
      { externalRef: 'B', amount: 100, occurredAt: TODAY },
    ],
    bankLines: [{ externalRef: 'A', amount: 300, occurredAt: TODAY }],
    asOf: TODAY,
  })

  assert.equal(result.summary.netDifference, 0)
  assert.equal(result.reconciled, false)
  assert.ok(result.diffs.length > 0)
})

test('summary 覆盖条数与各类计数', () => {
  const result = reconcile({
    ledgerLines: [
      { externalRef: 'A', amount: 100, occurredAt: TODAY },
      { externalRef: 'B', amount: 50, occurredAt: FIVE_DAYS_AGO },
    ],
    bankLines: [
      { externalRef: 'A', amount: 100, occurredAt: TODAY },
      { externalRef: 'C', amount: 70, occurredAt: TODAY },
    ],
    asOf: TODAY,
  })

  assert.deepEqual(
    [result.summary.ledgerCount, result.summary.bankCount, result.summary.matchedCount, result.summary.diffCount],
    [2, 2, 1, 2],
  )
  assert.equal(result.summary.byKind.MISSING_IN_BANK, 1)
  assert.equal(result.summary.byKind.MISSING_IN_LEDGER, 1)
})
