/**
 * 金额表示：最小货币单位（人民币「分」）的整数。
 *
 * 这是账务系统的第一道防线——绝不让浮点数参与任何金额运算。
 * `0.1 + 0.2 !== 0.3` 在账务里不是一个小 quiz，是一次对账差异。
 *
 * 所有接口只接受 `Minor`（number，必须是通过 Number.isSafeInteger 校验的整数），
 * 对外展示时才通过 formatMoney 转成人类可读的字符串。
 */

export type Currency = 'CNY' | 'USD'

/** 最小货币单位的整数值，例如 12345 表示 123.45 元。 */
export type Minor = number

export interface Money {
  readonly minor: Minor
  readonly currency: Currency
}

const SCALE: Record<Currency, number> = { CNY: 100, USD: 100 }

/** 校验金额：必须是安全整数，否则直接抛错——宁可拒绝，不要静默截断。 */
export function assertMinor(minor: number): Minor {
  if (typeof minor !== 'number' || !Number.isSafeInteger(minor)) {
    throw new RangeError(`金额必须是安全整数（最小货币单位），收到：${String(minor)}`)
  }
  return minor
}

export function money(minor: number, currency: Currency = 'CNY'): Money {
  return Object.freeze({ minor: assertMinor(minor), currency })
}

export function zero(currency: Currency = 'CNY'): Money {
  return money(0, currency)
}

export function isZero(a: Money): boolean {
  return a.minor === 0
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`币种不一致：${a.currency} vs ${b.currency}`)
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b)
  return money(a.minor + b.minor, a.currency)
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b)
  return money(a.minor - b.minor, a.currency)
}

export function negate(a: Money): Money {
  return money(-a.minor, a.currency)
}

export function abs(a: Money): Money {
  return money(Math.abs(a.minor), a.currency)
}

/** 按比例计算金额（例如按 0.6% 收手续费），四舍五入到分，不用浮点乘法直接落地。 */
export function multiplyByRate(a: Money, numerator: number, denominator: number): Money {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator === 0) {
    throw new RangeError('比例必须以整数分子/分母传入，例如 6/1000 表示千分之六')
  }
  const product = a.minor * numerator
  if (!Number.isSafeInteger(product)) {
    throw new RangeError('金额乘法溢出安全整数范围')
  }
  // 四舍五入取整，避免浮点误差；负数按绝对值处理后再还原符号
  const sign = product < 0 ? -1 : 1
  const absProduct = Math.abs(product)
  const rounded = Math.floor((absProduct * 2 + denominator) / (denominator * 2))
  return money(sign * rounded, a.currency)
}

const MONEY_PATTERN = /^(-?)(\d+)(?:\.(\d{1,2}))?$/

/**
 * 解析人类输入的金额字符串（支持千分位逗号、1~2 位小数）。
 * 不接受超过两位小数：`1.005` 直接报错，而不是悄悄舍入。
 */
export function parseMoney(text: string, currency: Currency = 'CNY'): Money {
  const cleaned = String(text).trim().replace(/,/g, '')
  const matched = MONEY_PATTERN.exec(cleaned)
  if (!matched) {
    throw new SyntaxError(`无法解析金额（最多两位小数）：${text}`)
  }
  const sign = matched[1] === '-' ? -1 : 1
  const whole = matched[2] ?? '0'
  const fraction = (matched[3] ?? '').padEnd(2, '0')
  const minor = Number(whole) * SCALE[currency] + Number(fraction)
  return money(sign * minor, currency)
}

/** 输出形如 `-1234.50`。不带千分位，便于日志与对账 diff 对齐。 */
export function formatMoney(a: Money): string {
  const sign = a.minor < 0 ? '-' : ''
  const abs = Math.abs(a.minor)
  const whole = Math.floor(abs / SCALE[a.currency])
  const fraction = String(abs % SCALE[a.currency]).padStart(2, '0')
  return `${sign}${whole}.${fraction}`
}
