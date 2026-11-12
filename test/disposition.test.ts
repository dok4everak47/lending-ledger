import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reconcile } from '../src/recon/reconcile.ts'
import type { ReconDiff } from '../src/recon/reconcile.ts'
import { OWNERS, dispose, toWorklist } from '../src/recon/disposition.ts'

const diff = (over: Partial<ReconDiff> & Pick<ReconDiff, 'kind'>): ReconDiff => ({
  externalRef: 'SETTLE-X',
  ledgerAmount: 100,
  bankAmount: 100,
  ageDays: 0,
  inTransit: false,
  suggestion: '',
  ...over,
})

test('在途与超窗走两条完全不同的路：一个归系统，一个归运营', () => {
  const transit = dispose(diff({ kind: 'MISSING_IN_BANK', inTransit: true, ageDays: 0 }))
  assert.equal(transit.owner, 'SYSTEM')
  assert.equal(transit.priority, 'P2')
  assert.equal(transit.slaHours, 0)
  assert.equal(transit.moneyAtRisk, false)

  const overdue = dispose(diff({ kind: 'MISSING_IN_BANK', inTransit: false, ageDays: 3 }))
  assert.equal(overdue.owner, 'OPS')
  assert.equal(overdue.priority, 'P1')
  assert.ok(overdue.slaHours > 0)
  assert.equal(overdue.moneyAtRisk, true)
})

test('超窗超过 7 天升到 P0（钱可能已经不在渠道手里）', () => {
  assert.equal(dispose(diff({ kind: 'MISSING_IN_BANK', ageDays: 7 })).priority, 'P1')
  assert.equal(dispose(diff({ kind: 'MISSING_IN_BANK', ageDays: 8 })).priority, 'P0')
})

test('单边有账一律 P0：钱到了但账上没有，是最急的一类', () => {
  const item = dispose(diff({ kind: 'MISSING_IN_LEDGER', ledgerAmount: null }))
  assert.equal(item.priority, 'P0')
  assert.equal(item.owner, 'FINANCE')
  assert.equal(item.moneyAtRisk, true)
})

test('金额不符按分差分级：100 元以下 P1，以上 P0', () => {
  assert.equal(dispose(diff({ kind: 'AMOUNT_MISMATCH', ledgerAmount: 100_00, bankAmount: 100_00 - 1 })).priority, 'P1')
  assert.equal(dispose(diff({ kind: 'AMOUNT_MISMATCH', ledgerAmount: 100_00, bankAmount: 100_00 - 100_00 })).priority, 'P0')
})

test('账内重复入账归研发且当天处理（自己的错，认定最明确）', () => {
  const item = dispose(diff({ kind: 'DUPLICATE_IN_LEDGER' }))
  assert.equal(item.owner, 'ENGINEERING')
  assert.equal(item.priority, 'P0')
  assert.equal(item.slaHours, 8)
  assert.match(item.action, /冲正/)
})

test('每一类差异都能派到人，且动作是可执行的动词开头', () => {
  const kinds = [
    'MISSING_IN_BANK',
    'MISSING_IN_LEDGER',
    'AMOUNT_MISMATCH',
    'DUPLICATE_IN_BANK',
    'DUPLICATE_IN_LEDGER',
  ] as const

  for (const kind of kinds) {
    const item = dispose(diff({ kind }))
    assert.ok(OWNERS.includes(item.owner), `${kind} 派给了未知角色`)
    assert.ok(item.action.length > 8, `${kind} 的处置动作太笼统`)
    assert.ok(!/关注|留意|看一下/.test(item.action), `${kind} 的动作不可执行：${item.action}`)
  }
})

test('工单清单按优先级排序，并汇总出派活视角的数字', () => {
  const result = reconcile({
    ledgerLines: [
      { externalRef: 'A', amount: 200, occurredAt: '2026-11-11T00:00:00.000Z' },
      { externalRef: 'B', amount: 100, occurredAt: '2026-11-11T00:00:00.000Z' },
    ],
    bankLines: [
      { externalRef: 'A', amount: 300, occurredAt: '2026-11-11T00:00:00.000Z' },
      { externalRef: 'C', amount: 70, occurredAt: '2026-11-11T00:00:00.000Z' },
    ],
    asOf: '2026-11-11T12:00:00.000Z',
    inTransitWindowDays: 1,
  })

  const worklist = toWorklist(result.diffs)

  assert.equal(worklist.items.length, result.diffs.length)
  assert.equal(worklist.byPriority.P0 + worklist.byPriority.P1 + worklist.byPriority.P2, worklist.items.length)
  assert.ok(worklist.moneyAtRiskCount >= 2)
  assert.ok(worklist.manualCount >= 2)

  // P0 必须排在 P1/P2 前面
  const rank = { P0: 0, P1: 1, P2: 2 }
  const order = worklist.items.map((item) => rank[item.priority])
  assert.deepEqual(order, [...order].sort((a, b) => a - b))
})
