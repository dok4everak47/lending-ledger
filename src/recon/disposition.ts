/**
 * 差异处置：把「识别出差异」推进到「知道该谁在多久内做什么」。
 *
 * 对账到分类就停，等于把一道选择题交回给运营；补上处置规则，它才变成任务。
 * 这里只做纯映射（差异 → 工单），不发通知、不落库——真实系统里这一步会生成
 * 待办、挂到渠道/财务的看板上，那是集成层的事。
 *
 * 排序遵循一个原则：**钱在我们这边错得越明确，SLA 越紧**。
 * 账内重复入账是我们自己的错，当天必须处理；渠道回单多推一次，可以先核实再动作。
 */

import type { DiffKind, ReconDiff } from './reconcile.ts'

export const OWNERS = ['SYSTEM', 'OPS', 'FINANCE', 'ENGINEERING', 'BUSINESS'] as const
export type Owner = (typeof OWNERS)[number]

export const OWNER_LABEL: Record<Owner, string> = {
  SYSTEM: '系统（自动）',
  OPS: '运营 · 渠道对接',
  FINANCE: '财务 · 账务组',
  ENGINEERING: '研发 · 账务方向',
  BUSINESS: '业务 · 负责人',
}

export const PRIORITIES = ['P0', 'P1', 'P2'] as const
export type Priority = (typeof PRIORITIES)[number]

export interface Disposition {
  kind: DiffKind
  externalRef: string
  priority: Priority
  owner: Owner
  ownerLabel: string
  /** 具体动作，要求能直接执行，不是"关注一下" */
  action: string
  /** 首次处置时限（小时）；0 表示不需要人工 */
  slaHours: number
  /** 超过这个时限仍未闭环就升级（小时）；0 表示不需要 */
  escalateAfterHours: number
  escalateTo: Owner
  /** 是否涉及真实资金风险（需要冻结/追回/补记） */
  moneyAtRisk: boolean
}

const RULES: Record<
  DiffKind,
  (diff: ReconDiff) => Omit<Disposition, 'kind' | 'externalRef' | 'ownerLabel'>
> = {
  // 账已记、回单未到，且在 T+1 窗口内：系统自己重跑，不占人力
  MISSING_IN_BANK: (diff) =>
    diff.inTransit
      ? {
          priority: 'P2',
          owner: 'SYSTEM',
          action: '次日自动重跑对账，人工不介入',
          slaHours: 0,
          escalateAfterHours: 0,
          escalateTo: 'OPS',
          moneyAtRisk: false,
        }
      : {
          // 超过在途窗口仍无回单：钱可能还在渠道手里，按资金风险处理
          priority: diff.ageDays !== null && diff.ageDays > 7 ? 'P0' : 'P1',
          owner: 'OPS',
          action: '按渠道流水号向渠道发追单查询，拿到回单后补挂账；超 7 天未回单转资金风险流程',
          slaHours: 24,
          escalateAfterHours: 48,
          escalateTo: 'FINANCE',
          moneyAtRisk: true,
        },

  // 渠道有回款、账上没有：先按回单补记，再查丢单原因（否则下次还会丢）
  MISSING_IN_LEDGER: () => ({
    priority: 'P0',
    owner: 'FINANCE',
    action: '按回单在备付金户补记，同时提单给研发定位丢单环节（回调丢失 / 消费失败 / 幂等键复用）',
    slaHours: 8,
    escalateAfterHours: 24,
    escalateTo: 'ENGINEERING',
    moneyAtRisk: true,
  }),

  // 金额不符：先判口径（手续费/退款/汇率），再判错账
  AMOUNT_MISMATCH: (diff) => ({
    priority: Math.abs((diff.ledgerAmount ?? 0) - (diff.bankAmount ?? 0)) >= 100_00 ? 'P0' : 'P1',
    owner: 'FINANCE',
    action: '比对三处口径：手续费计提方式、部分退款、汇率折算时点；确认是口径差异就调规则，是错账就冲正',
    slaHours: 48,
    escalateAfterHours: 72,
    escalateTo: 'BUSINESS',
    moneyAtRisk: true,
  }),

  // 渠道重复回单：钱不一定真多收，先核实再动作
  DUPLICATE_IN_BANK: () => ({
    priority: 'P1',
    owner: 'OPS',
    action: '向渠道核实是否为同一笔重复推送；确认重复回款则登记退汇，未重复则修正回单文件',
    slaHours: 24,
    escalateAfterHours: 72,
    escalateTo: 'FINANCE',
    moneyAtRisk: true,
  }),

  // 账内重复入账：我们自己的错，当天冲正
  DUPLICATE_IN_LEDGER: () => ({
    priority: 'P0',
    owner: 'ENGINEERING',
    action: '保留一笔，其余逐笔冲正（红字反向分录）；排查触发重复的业务路径并补唯一约束',
    slaHours: 8,
    escalateAfterHours: 24,
    escalateTo: 'FINANCE',
    moneyAtRisk: true,
  }),
}

/** 一条差异 → 一张工单。 */
export function dispose(diff: ReconDiff): Disposition {
  const rule = RULES[diff.kind]
  const base = rule(diff)
  return {
    kind: diff.kind,
    externalRef: diff.externalRef,
    ownerLabel: OWNER_LABEL[base.owner],
    ...base,
  }
}

export interface Worklist {
  items: Disposition[]
  byOwner: Record<Owner, number>
  byPriority: Record<Priority, number>
  /** 需要人工处理（owner 不是 SYSTEM）的条数 */
  manualCount: number
  moneyAtRiskCount: number
}

/** 把对账结果整理成可派活的清单，按优先级与时限排序。 */
export function toWorklist(diffs: readonly ReconDiff[]): Worklist {
  const items = diffs.map(dispose).sort((a, b) => {
    const rank: Record<Priority, number> = { P0: 0, P1: 1, P2: 2 }
    if (rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority]
    return a.slaHours - b.slaHours || a.externalRef.localeCompare(b.externalRef)
  })

  const byOwner = Object.fromEntries(OWNERS.map((owner) => [owner, 0])) as Record<Owner, number>
  const byPriority = Object.fromEntries(PRIORITIES.map((p) => [p, 0])) as Record<Priority, number>

  for (const item of items) {
    byOwner[item.owner] += 1
    byPriority[item.priority] += 1
  }

  return {
    items,
    byOwner,
    byPriority,
    manualCount: items.filter((item) => item.owner !== 'SYSTEM').length,
    moneyAtRiskCount: items.filter((item) => item.moneyAtRisk).length,
  }
}
