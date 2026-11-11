import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CREDIT, DEBIT } from '../src/domain/accounts.ts'
import { InvalidEntryError, UnbalancedEntryError } from '../src/domain/journal.ts'
import type { Db } from '../src/store/db.ts'
import { fixture } from './helpers.ts'
import { AlreadyReversedError } from '../src/ledger/ledger.ts'

function count(db: Db, table: 'journal_entries' | 'postings'): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  return row.n
}

test('负债科目：贷方增加余额，借方减少', () => {
  const { ledger, wallet, payable } = fixture(500_00)
  assert.equal(ledger.balance(wallet.id).minor, 500_00)

  ledger.post({
    currency: 'CNY',
    postings: [
      { accountId: wallet.id, side: DEBIT, amount: 100_00 },
      { accountId: payable.id, side: CREDIT, amount: 100_00 },
    ],
  })

  assert.equal(ledger.balance(wallet.id).minor, 400_00)
  assert.equal(ledger.balance(payable.id).minor, 100_00)
  assert.equal(ledger.balance(wallet.id).normalSide, CREDIT)
})

test('posting 的 seq 按落库顺序连续，便于审计回放', () => {
  const { ledger, wallet, payable } = fixture(100_00)
  const entry = ledger.post({
    currency: 'CNY',
    postings: [
      { accountId: wallet.id, side: DEBIT, amount: 60 },
      { accountId: payable.id, side: CREDIT, amount: 60 },
    ],
  })
  assert.deepEqual(
    entry.postings.map((posting) => posting.seq),
    [1, 2],
  )
})

test('不平衡分录不落库（事务回滚）', () => {
  const { db, ledger, wallet, payable } = fixture(100_00)
  const before = count(db, 'journal_entries')
  assert.throws(
    () =>
      ledger.post({
        currency: 'CNY',
        postings: [
          { accountId: wallet.id, side: DEBIT, amount: 100 },
          { accountId: payable.id, side: CREDIT, amount: 99 },
        ],
      }),
    UnbalancedEntryError,
  )
  assert.equal(count(db, 'journal_entries'), before)
})

test('分录币种与科目币种不一致时拒绝', () => {
  const { ledger, wallet, payable } = fixture(100_00)
  assert.throws(
    () =>
      ledger.post({
        currency: 'USD',
        postings: [
          { accountId: wallet.id, side: DEBIT, amount: 100 },
          { accountId: payable.id, side: CREDIT, amount: 100 },
        ],
      }),
    InvalidEntryError,
  )
})

test('冲正：生成反向分录，原分录原封不动', () => {
  const { db, ledger, wallet, payable } = fixture(500_00)
  const entry = ledger.post({
    currency: 'CNY',
    postings: [
      { accountId: wallet.id, side: DEBIT, amount: 100_00 },
      { accountId: payable.id, side: CREDIT, amount: 100_00 },
    ],
    externalRef: 'TX-1',
  })

  const balanceAfterPay = ledger.balance(wallet.id).minor
  const reversal = ledger.reverse(entry.id)

  assert.equal(ledger.balance(wallet.id).minor, balanceAfterPay + 100_00)
  assert.equal(reversal.reversalOf, entry.id)
  assert.deepEqual(
    reversal.postings.map((posting) => posting.side),
    [CREDIT, DEBIT],
  )

  const original = ledger.entry(entry.id)
  assert.equal(original?.postings.length, 2)
  assert.deepEqual(
    original?.postings.map((posting) => posting.amount),
    [100_00, 100_00],
  )
  assert.equal(count(db, 'journal_entries'), 3) // 期初 + 原分录 + 冲正
})

test('同一分录不能冲正两次', () => {
  const { ledger, wallet, payable } = fixture(500_00)
  const entry = ledger.post({
    currency: 'CNY',
    postings: [
      { accountId: wallet.id, side: DEBIT, amount: 10_00 },
      { accountId: payable.id, side: CREDIT, amount: 10_00 },
    ],
  })
  ledger.reverse(entry.id)
  assert.throws(() => ledger.reverse(entry.id), AlreadyReversedError)
})

test('冲正分录本身不能再被冲正', () => {
  const { ledger, wallet, payable } = fixture(500_00)
  const entry = ledger.post({
    currency: 'CNY',
    postings: [
      { accountId: wallet.id, side: DEBIT, amount: 10_00 },
      { accountId: payable.id, side: CREDIT, amount: 10_00 },
    ],
  })
  const reversal = ledger.reverse(entry.id)
  assert.throws(() => ledger.reverse(reversal.id), InvalidEntryError)
})

test('试算平衡：全部科目借方合计 === 贷方合计', () => {
  const { ledger, wallet, payable, reserve, feeRevenue } = fixture(500_00)
  ledger.post({
    currency: 'CNY',
    postings: [
      { accountId: wallet.id, side: DEBIT, amount: 100_00 },
      { accountId: payable.id, side: CREDIT, amount: 99_40 },
      { accountId: feeRevenue.id, side: CREDIT, amount: 60 },
    ],
  })
  ledger.post({
    currency: 'CNY',
    postings: [
      { accountId: payable.id, side: DEBIT, amount: 99_40 },
      { accountId: reserve.id, side: CREDIT, amount: 99_40 },
    ],
  })

  const trial = ledger.trialBalance()
  const debits = trial.reduce((sum, row) => sum + row.debits, 0)
  const credits = trial.reduce((sum, row) => sum + row.credits, 0)
  assert.equal(debits, credits)
  assert.equal(ledger.balance(payable.id).minor, 0)
})

test('statement 只返回带回单号的流水，供对账匹配', () => {
  const { ledger, wallet, payable, reserve } = fixture(500_00)
  ledger.post({
    currency: 'CNY',
    postings: [
      { accountId: wallet.id, side: DEBIT, amount: 100 },
      { accountId: payable.id, side: CREDIT, amount: 100 },
    ],
    externalRef: 'TX-9',
  })
  ledger.post({
    currency: 'CNY',
    postings: [
      { accountId: payable.id, side: DEBIT, amount: 100 },
      { accountId: reserve.id, side: CREDIT, amount: 100 },
    ],
    externalRef: 'SETTLE-TX-9',
  })

  const bankLines = ledger.statement(reserve.id, { side: CREDIT })
  assert.equal(bankLines.length, 1)
  assert.equal(bankLines[0]?.externalRef, 'SETTLE-TX-9')
  assert.equal(bankLines[0]?.amount, 100)
})

test('未注册科目录入时直接失败', () => {
  const { ledger } = fixture(0)
  assert.throws(
    () =>
      ledger.post({
        currency: 'CNY',
        postings: [
          { accountId: 'nope', side: DEBIT, amount: 1 },
          { accountId: 'nope2', side: CREDIT, amount: 1 },
        ],
      }),
    /科目不存在/,
  )
})
