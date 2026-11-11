import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  add,
  assertMinor,
  formatMoney,
  money,
  multiplyByRate,
  negate,
  parseMoney,
} from '../src/domain/money.ts'

test('金额一律以分为单位存储', () => {
  assert.equal(parseMoney('1,234.56').minor, 123456)
  assert.equal(parseMoney('0.01').minor, 1)
  assert.equal(parseMoney('100').minor, 10000)
  assert.equal(parseMoney('-8.5').minor, -850)
})

test('超过两位小数直接拒绝，绝不悄悄舍入', () => {
  assert.throws(() => parseMoney('1.005'), SyntaxError)
  assert.throws(() => parseMoney('abc'), SyntaxError)
  assert.throws(() => parseMoney('1.2.3'), SyntaxError)
})

test('非整数金额一律拒绝', () => {
  assert.throws(() => assertMinor(1.5), RangeError)
  assert.throws(() => assertMinor(Number.NaN), RangeError)
  assert.throws(() => money(Number.MAX_SAFE_INTEGER + 2), RangeError)
})

test('浮点经典陷阱在整数分下不成立', () => {
  const result = add(parseMoney('0.1'), parseMoney('0.2'))
  assert.equal(formatMoney(result), '0.30')
  assert.equal(result.minor, 30)
})

test('币种不一致拒绝相加', () => {
  assert.throws(() => add(money(100, 'CNY'), money(100, 'USD')), TypeError)
})

test('formatMoney 支持负数与两位补零', () => {
  assert.equal(formatMoney(money(-123456)), '-1234.56')
  assert.equal(formatMoney(money(5)), '0.05')
  assert.equal(formatMoney(negate(money(99))), '-0.99')
})

test('按比例计费四舍五入到分', () => {
  // 千分之六：100.00 元 → 0.60 元
  assert.equal(multiplyByRate(money(10000), 6, 1000).minor, 60)
  // 0.5 分向上取整
  assert.equal(multiplyByRate(money(1), 1, 2).minor, 1)
  // 0.49 分向下取整
  assert.equal(multiplyByRate(money(49), 1, 100).minor, 0)
})
