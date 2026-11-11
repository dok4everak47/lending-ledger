/**
 * 转账单状态机。
 *
 * 状态迁移是支付系统的第二道防线：所有写操作都必须经过 assertTransition，
 * 而不是靠 if 判断散落在 service 里。任何「跳状态」都是 bug，不是特例。
 *
 *   CREATED ──▶ AUTHORIZED ──▶ POSTED ──▶ SETTLED
 *      │            │            │           │
 *      ▼            ▼            ▼           ▼
 *    FAILED       FAILED      REVERSED    REVERSED
 *
 * 终态：FAILED / REVERSED（不可再迁移）。
 */

export const TRANSFER_STATUSES = [
  'CREATED',
  'AUTHORIZED',
  'POSTED',
  'SETTLED',
  'FAILED',
  'REVERSED',
] as const

export type TransferStatus = (typeof TRANSFER_STATUSES)[number]

const ALLOWED: Record<TransferStatus, readonly TransferStatus[]> = {
  CREATED: ['AUTHORIZED', 'FAILED'],
  AUTHORIZED: ['POSTED', 'FAILED'],
  POSTED: ['SETTLED', 'REVERSED'],
  SETTLED: ['REVERSED'],
  FAILED: [],
  REVERSED: [],
}

export const TERMINAL_STATUSES: readonly TransferStatus[] = ['FAILED', 'REVERSED']

export class InvalidTransitionError extends Error {
  readonly from: TransferStatus
  readonly to: TransferStatus

  constructor(from: TransferStatus, to: TransferStatus) {
    super(`非法状态迁移：${from} → ${to}`)
    this.name = 'InvalidTransitionError'
    this.from = from
    this.to = to
  }
}

export function isTransferStatus(value: string): value is TransferStatus {
  return (TRANSFER_STATUSES as readonly string[]).includes(value)
}

export function canTransition(from: TransferStatus, to: TransferStatus): boolean {
  return ALLOWED[from].includes(to)
}

export function assertTransition(from: TransferStatus, to: TransferStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to)
}

export function allowedFrom(from: TransferStatus): readonly TransferStatus[] {
  return ALLOWED[from]
}

export function isTerminal(status: TransferStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}
