/**
 * 对账：拿「账上应该有的」对「银行/渠道说实际有的」。
 *
 * 差异必须分类，不能只报一个总数——因为每一类的处置动作完全不同：
 *   - 在途（T+1 未回单）：等，不动账；
 *   - 单边有账：补记或追单；
 *   - 金额不符：查手续费/汇率/部分退款；
 *   - 重复入账：冲正。
 *
 * 匹配键用 externalRef（业务单号），这是账务与渠道之间唯一稳定的锚点。
 */

export interface ReconLine {
  externalRef: string
  amount: number
  occurredAt: string
}

export type DiffKind =
  | 'AMOUNT_MISMATCH'
  | 'MISSING_IN_LEDGER'
  | 'MISSING_IN_BANK'
  | 'DUPLICATE_IN_BANK'
  | 'DUPLICATE_IN_LEDGER'

export interface ReconDiff {
  kind: DiffKind
  externalRef: string
  ledgerAmount: number | null
  bankAmount: number | null
  ageDays: number | null
  /** 在途：MISSING_IN_BANK 且在容忍窗口内，通常无需人工处理 */
  inTransit: boolean
  suggestion: string
}

export interface MatchedPair {
  externalRef: string
  amount: number
  occurredAt: string
}

export interface ReconSummary {
  ledgerCount: number
  bankCount: number
  matchedCount: number
  diffCount: number
  byKind: Record<DiffKind, number>
  ledgerTotal: number
  bankTotal: number
  /** 账 - 银行，0 表示总量轧平（不代表无差异，重复与对消会互相抵消） */
  netDifference: number
}

export interface ReconResult {
  matched: MatchedPair[]
  diffs: ReconDiff[]
  summary: ReconSummary
  /** 无差异（既无单边也无金额不符，且总量轧平） */
  reconciled: boolean
}

export interface ReconInput {
  ledgerLines: readonly ReconLine[]
  bankLines: readonly ReconLine[]
  /** 对账基准时间，默认当前时间 */
  asOf?: string
  /** 在途容忍窗口（天），默认 1 天 */
  inTransitWindowDays?: number
}

const DAY_MS = 24 * 60 * 60 * 1000

function ageInDays(occurredAt: string, asOf: string): number | null {
  const at = Date.parse(occurredAt)
  const now = Date.parse(asOf)
  if (Number.isNaN(at) || Number.isNaN(now)) return null
  return Math.max(0, Math.floor((now - at) / DAY_MS))
}

function groupByRef(lines: readonly ReconLine[]): Map<string, ReconLine[]> {
  const grouped = new Map<string, ReconLine[]>()
  for (const line of lines) {
    const bucket = grouped.get(line.externalRef)
    if (bucket) bucket.push(line)
    else grouped.set(line.externalRef, [line])
  }
  return grouped
}

function sumOf(lines: readonly ReconLine[]): number {
  return lines.reduce((total, line) => total + line.amount, 0)
}

const EMPTY_BY_KIND: Record<DiffKind, number> = {
  AMOUNT_MISMATCH: 0,
  MISSING_IN_LEDGER: 0,
  MISSING_IN_BANK: 0,
  DUPLICATE_IN_BANK: 0,
  DUPLICATE_IN_LEDGER: 0,
}

export function reconcile(input: ReconInput): ReconResult {
  const asOf = input.asOf ?? new Date().toISOString()
  const windowDays = input.inTransitWindowDays ?? 1

  const ledgerByRef = groupByRef(input.ledgerLines)
  const bankByRef = groupByRef(input.bankLines)

  const matched: MatchedPair[] = []
  const diffs: ReconDiff[] = []
  const byKind: Record<DiffKind, number> = { ...EMPTY_BY_KIND }

  const push = (diff: ReconDiff): void => {
    diffs.push(diff)
    byKind[diff.kind] += 1
  }

  const refs = new Set<string>([...ledgerByRef.keys(), ...bankByRef.keys()])

  for (const ref of [...refs].sort()) {
    const ledgerGroup = ledgerByRef.get(ref) ?? []
    const bankGroup = bankByRef.get(ref) ?? []
    const ledgerAmount = ledgerGroup.length > 0 ? sumOf(ledgerGroup) : null
    const bankAmount = bankGroup.length > 0 ? sumOf(bankGroup) : null
    const firstLedger = ledgerGroup[0]
    const firstBank = bankGroup[0]
    const ageDays = ageInDays(firstLedger?.occurredAt ?? firstBank?.occurredAt ?? asOf, asOf)

    if (ledgerGroup.length > 1) {
      push({
        kind: 'DUPLICATE_IN_LEDGER',
        externalRef: ref,
        ledgerAmount,
        bankAmount,
        ageDays,
        inTransit: false,
        suggestion: `账内同一单号 ${ledgerGroup.length} 笔，核对是否重复入账，保留一笔并冲正其余`,
      })
      continue
    }

    if (bankGroup.length > 1) {
      push({
        kind: 'DUPLICATE_IN_BANK',
        externalRef: ref,
        ledgerAmount,
        bankAmount,
        ageDays,
        inTransit: false,
        suggestion: `渠道回单同一单号 ${bankGroup.length} 笔，先向渠道核实是否重复回款`,
      })
      continue
    }

    if (ledgerGroup.length === 1 && bankGroup.length === 1) {
      if (ledgerAmount === bankAmount) {
        matched.push({
          externalRef: ref,
          amount: ledgerAmount ?? 0,
          occurredAt: firstLedger?.occurredAt ?? '',
        })
      } else {
        push({
          kind: 'AMOUNT_MISMATCH',
          externalRef: ref,
          ledgerAmount,
          bankAmount,
          ageDays,
          inTransit: false,
          suggestion: `金额差异 ${(ledgerAmount ?? 0) - (bankAmount ?? 0)} 分，查手续费/退款/汇率折算`,
        })
      }
      continue
    }

    if (ledgerGroup.length === 1) {
      push({
        kind: 'MISSING_IN_BANK',
        externalRef: ref,
        ledgerAmount,
        bankAmount: null,
        ageDays,
        inTransit: ageDays !== null && ageDays <= windowDays,
        suggestion:
          ageDays !== null && ageDays <= windowDays
            ? '账已记、回单未到，T+1 内属正常在途，次日重跑对账'
            : '超过在途窗口仍无回单，需向渠道追单',
      })
      continue
    }

    push({
      kind: 'MISSING_IN_LEDGER',
      externalRef: ref,
      ledgerAmount: null,
      bankAmount,
      ageDays,
      inTransit: false,
      suggestion: '渠道有回款、账上无记录，按回单补记并追查丢单原因',
    })
  }

  const ledgerTotal = sumOf(input.ledgerLines)
  const bankTotal = sumOf(input.bankLines)

  return {
    matched,
    diffs,
    summary: {
      ledgerCount: input.ledgerLines.length,
      bankCount: input.bankLines.length,
      matchedCount: matched.length,
      diffCount: diffs.length,
      byKind,
      ledgerTotal,
      bankTotal,
      netDifference: ledgerTotal - bankTotal,
    },
    reconciled: diffs.length === 0 && ledgerTotal === bankTotal,
  }
}
