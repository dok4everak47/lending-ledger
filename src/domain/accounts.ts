/**
 * 会计科目：类型决定「余额的正常方向」。
 *
 * 资产/费用 借方为增；负债/权益/收入 贷方为增。
 * 计算余额时不看单笔借贷，而是把两侧合计按科目类型折算到正常方向——
 * 这样 `余额 = 借合计 - 贷合计`（资产）与 `贷合计 - 借合计`（负债）语义一致，
 * 负数即「反向余额」，属于业务异常信号（例如结算户透支），必须暴露而不是藏起来。
 */

export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

export const DEBIT = 'DEBIT' as const
export const CREDIT = 'CREDIT' as const
export type Side = typeof DEBIT | typeof CREDIT

export const SIDES: readonly Side[] = [DEBIT, CREDIT]

export const NORMAL_SIDE: Record<AccountType, Side> = {
  ASSET: DEBIT,
  EXPENSE: DEBIT,
  LIABILITY: CREDIT,
  EQUITY: CREDIT,
  REVENUE: CREDIT,
}

export type Account = {
  id: string
  code: string
  name: string
  type: AccountType
  currency: string
}

export function opposite(side: Side): Side {
  return side === DEBIT ? CREDIT : DEBIT
}

export function isAccountType(value: string): value is AccountType {
  return (ACCOUNT_TYPES as readonly string[]).includes(value)
}

/** 按科目类型折算后的余额（最小货币单位）。 */
export function balanceOf(type: AccountType, debits: number, credits: number): number {
  return NORMAL_SIDE[type] === DEBIT ? debits - credits : credits - debits
}
