/**
 * 复式记账的不变量（Invariants）：
 *
 * 1. 一笔分录至少两条 posting（有借必有贷）；
 * 2. 每条 posting 的金额为正整数（方向由 side 表达，不用负数当方向）；
 * 3. 借方合计 === 贷方合计（借贷必相等，且币种一致）；
 * 4. 分录一经写入不可修改，只能新增冲正分录（见 ledger.reverse）。
 *
 * 校验失败一律抛错而不是返回 false —— 账务错误不允许被忽略。
 */

import { createHash } from 'node:crypto'
import type { Side } from './accounts.ts'
import { CREDIT, DEBIT } from './accounts.ts'
import type { Currency } from './money.ts'

export interface PostingInput {
  accountId: string
  side: Side
  /** 最小货币单位，必须 > 0 */
  amount: number
}

export interface EntryDraft {
  currency: Currency
  postings: PostingInput[]
  memo?: string
  /** 外部业务单号（支付单 / 结算批次），对账靠它做匹配键 */
  externalRef?: string
  transferId?: string
  occurredAt?: string
  /** 冲正时指向被冲正的分录 */
  reversalOf?: string
}

export class InvalidEntryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidEntryError'
  }
}

export class UnbalancedEntryError extends Error {
  readonly debits: number
  readonly credits: number

  constructor(debits: number, credits: number) {
    super(`借贷不平：借方合计 ${debits}，贷方合计 ${credits}，差额 ${debits - credits}`)
    this.name = 'UnbalancedEntryError'
    this.debits = debits
    this.credits = credits
  }
}

export function totalOf(postings: readonly PostingInput[], side: Side): number {
  let total = 0
  for (const posting of postings) {
    if (posting.side === side) total += posting.amount
  }
  return total
}

export function assertValidEntry(postings: readonly PostingInput[]): void {
  if (!Array.isArray(postings) || postings.length < 2) {
    throw new InvalidEntryError('分录至少需要两条 posting（有借必有贷）')
  }
  for (const posting of postings) {
    if (posting.side !== DEBIT && posting.side !== CREDIT) {
      throw new InvalidEntryError(`未知的记账方向：${String(posting.side)}`)
    }
    if (!Number.isSafeInteger(posting.amount) || posting.amount <= 0) {
      throw new InvalidEntryError(`posting 金额必须是正的安全整数，收到：${String(posting.amount)}`)
    }
    if (typeof posting.accountId !== 'string' || posting.accountId.length === 0) {
      throw new InvalidEntryError('posting 缺少 accountId')
    }
  }
}

export function assertBalanced(postings: readonly PostingInput[]): void {
  const debits = totalOf(postings, DEBIT)
  const credits = totalOf(postings, CREDIT)
  if (debits !== credits) throw new UnbalancedEntryError(debits, credits)
}

/** 先校验形状，再校验平衡；顺序固定，便于错误定位。 */
export function assertEntry(postings: readonly PostingInput[]): void {
  assertValidEntry(postings)
  assertBalanced(postings)
}

/** 稳定序列化：对象键排序后输出，保证同样的内容永远得到同样的指纹。 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
  return `{${parts.join(',')}}`
}

/** 内容指纹，用于审计比对与幂等判定（不用于防篡改，防篡改用签名/哈希链）。 */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex')
}
