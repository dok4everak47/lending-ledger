import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CREDIT, DEBIT } from '../src/domain/accounts.ts'
import {
  InvalidEntryError,
  UnbalancedEntryError,
  assertBalanced,
  assertValidEntry,
  canonicalize,
  fingerprint,
} from '../src/domain/journal.ts'

test('借贷不平必须抛错，并带上差额', () => {
  try {
    assertBalanced([
      { accountId: 'a', side: DEBIT, amount: 100 },
      { accountId: 'b', side: CREDIT, amount: 90 },
    ])
    assert.fail('应当抛错')
  } catch (error) {
    assert.ok(error instanceof UnbalancedEntryError)
    assert.equal(error.debits, 100)
    assert.equal(error.credits, 90)
  }
})

test('借贷相等时通过', () => {
  assert.doesNotThrow(() =>
    assertBalanced([
      { accountId: 'a', side: DEBIT, amount: 100 },
      { accountId: 'b', side: CREDIT, amount: 100 },
    ]),
  )
})

test('只有一条 posting 不是分录', () => {
  assert.throws(
    () => assertValidEntry([{ accountId: 'a', side: DEBIT, amount: 100 }]),
    InvalidEntryError,
  )
})

test('金额必须为正整数：0 与负数都不合法', () => {
  assert.throws(
    () =>
      assertValidEntry([
        { accountId: 'a', side: DEBIT, amount: 0 },
        { accountId: 'b', side: CREDIT, amount: 0 },
      ]),
    InvalidEntryError,
  )
  assert.throws(
    () =>
      assertValidEntry([
        { accountId: 'a', side: DEBIT, amount: -100 },
        { accountId: 'b', side: CREDIT, amount: -100 },
      ]),
    InvalidEntryError,
  )
})

test('未知方向被拒绝', () => {
  assert.throws(
    () =>
      assertValidEntry([
        { accountId: 'a', side: 'UP' as never, amount: 100 },
        { accountId: 'b', side: CREDIT, amount: 100 },
      ]),
    InvalidEntryError,
  )
})

test('指纹与对象键顺序无关', () => {
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }))
  assert.equal(
    fingerprint({ postings: [{ x: 1, y: 2 }], memo: 'm' }),
    fingerprint({ memo: 'm', postings: [{ y: 2, x: 1 }] }),
  )
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }))
})

test('canonicalize 处理嵌套数组与 null', () => {
  assert.equal(canonicalize({ b: [1, { d: 4, c: 3 }], a: null }), '{"a":null,"b":[1,{"c":3,"d":4}]}')
})
