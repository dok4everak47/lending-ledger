import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  InvalidTransitionError,
  allowedFrom,
  assertTransition,
  canTransition,
  isTerminal,
} from '../src/domain/state-machine.ts'

test('正常主链路可迁移', () => {
  assert.doesNotThrow(() => assertTransition('CREATED', 'AUTHORIZED'))
  assert.doesNotThrow(() => assertTransition('AUTHORIZED', 'POSTED'))
  assert.doesNotThrow(() => assertTransition('POSTED', 'SETTLED'))
  assert.doesNotThrow(() => assertTransition('SETTLED', 'REVERSED'))
})

test('跳状态一律拒绝：CREATED 不能直接 POSTED', () => {
  assert.throws(() => assertTransition('CREATED', 'POSTED'), InvalidTransitionError)
  assert.equal(canTransition('CREATED', 'POSTED'), false)
})

test('终态不可再迁移', () => {
  assert.equal(isTerminal('REVERSED'), true)
  assert.equal(isTerminal('FAILED'), true)
  assert.deepEqual(allowedFrom('FAILED'), [])
  assert.throws(() => assertTransition('FAILED', 'AUTHORIZED'), InvalidTransitionError)
  assert.throws(() => assertTransition('REVERSED', 'POSTED'), InvalidTransitionError)
})

test('错误信息带上 from → to，方便直接定位', () => {
  try {
    assertTransition('POSTED', 'AUTHORIZED')
    assert.fail('应当抛错')
  } catch (error) {
    assert.ok(error instanceof InvalidTransitionError)
    assert.match(error.message, /POSTED → AUTHORIZED/)
  }
})
