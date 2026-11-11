/**
 * 账务核心：科目、分录、余额、冲正。
 *
 * 这里只做会计本身，不掺业务（谁付谁、收多少手续费是 payments 层的事）。
 * 所有写操作都在一个事务里完成，且分录只追加、不可改。
 */

import { randomUUID } from 'node:crypto'
import type { Account, AccountType, Side } from '../domain/accounts.ts'
import { NORMAL_SIDE, balanceOf, opposite } from '../domain/accounts.ts'
import type { EntryDraft, PostingInput } from '../domain/journal.ts'
import { InvalidEntryError, assertEntry, fingerprint } from '../domain/journal.ts'
import type { Currency } from '../domain/money.ts'
import type { Db } from '../store/db.ts'
import { nowIso, withTx } from '../store/db.ts'

export interface Posting extends PostingInput {
  id: number
  seq: number
}

export interface Entry {
  id: string
  occurredAt: string
  currency: Currency
  memo: string
  externalRef: string | null
  transferId: string | null
  reversalOf: string | null
  fingerprint: string
  createdAt: string
  postings: Posting[]
}

export interface Balance {
  accountId: string
  currency: string
  /** 按科目类型折算到正常方向的余额，最小货币单位；负数代表反向余额 */
  minor: number
  normalSide: Side
}

export interface StatementLine {
  entryId: string
  externalRef: string
  amount: number
  occurredAt: string
  side: Side
}

export class AccountNotFoundError extends Error {
  readonly code: string

  constructor(code: string) {
    super(`科目不存在：${code}`)
    this.name = 'AccountNotFoundError'
    this.code = code
  }
}

export class AlreadyReversedError extends Error {
  constructor(entryId: string) {
    super(`分录 ${entryId} 已被冲正，不能重复冲正`)
    this.name = 'AlreadyReversedError'
  }
}

type AccountRow = {
  id: string
  code: string
  name: string
  type: string
  currency: string
}

type EntryRow = {
  id: string
  occurred_at: string
  currency: string
  memo: string
  external_ref: string | null
  transfer_id: string | null
  reversal_of: string | null
  fingerprint: string
  created_at: string
}

type PostingRow = {
  id: number
  entry_id: string
  account_id: string
  side: Side
  amount: number
  seq: number
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type as AccountType,
    currency: row.currency,
  }
}

/** 分录指纹按「科目+方向+金额」排序后计算，与 posting 书写顺序无关。 */
function entryFingerprint(draft: EntryDraft): string {
  const postings = draft.postings
    .map((posting) => ({ accountId: posting.accountId, side: posting.side, amount: posting.amount }))
    .sort((a, b) => (a.accountId + a.side + a.amount).localeCompare(b.accountId + b.side + b.amount))
  return fingerprint({ currency: draft.currency, postings })
}

export class Ledger {
  private db: Db

  constructor(db: Db) {
    this.db = db
  }

  openAccount(input: {
    code: string
    name: string
    type: AccountType
    currency?: string
    id?: string
  }): Account {
    const id = input.id ?? randomUUID()
    this.db
      .prepare(
        `INSERT INTO accounts (id, code, name, type, currency, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.code, input.name, input.type, input.currency ?? 'CNY', nowIso())
    return this.account(input.code)
  }

  account(code: string): Account {
    const row = this.db.prepare('SELECT * FROM accounts WHERE code = ?').get(code) as
      | AccountRow
      | undefined
    if (!row) throw new AccountNotFoundError(code)
    return toAccount(row)
  }

  accountById(id: string): Account {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
      | AccountRow
      | undefined
    if (!row) throw new AccountNotFoundError(id)
    return toAccount(row)
  }

  /** 写一笔分录。校验失败抛错；成功返回落库后的完整分录。 */
  post(draft: EntryDraft): Entry {
    assertEntry(draft.postings)

    const id = randomUUID()
    const occurredAt = draft.occurredAt ?? nowIso()
    const createdAt = nowIso()
    const print = entryFingerprint(draft)

    withTx(this.db, () => {
      for (const posting of draft.postings) {
        const account = this.accountById(posting.accountId)
        if (account.currency !== draft.currency) {
          throw new InvalidEntryError(
            `科目 ${account.code} 的币种 ${account.currency} 与分录币种 ${draft.currency} 不一致`,
          )
        }
      }

      this.db
        .prepare(
          `INSERT INTO journal_entries
             (id, occurred_at, currency, memo, external_ref, transfer_id, reversal_of, fingerprint, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          occurredAt,
          draft.currency,
          draft.memo ?? '',
          draft.externalRef ?? null,
          draft.transferId ?? null,
          draft.reversalOf ?? null,
          print,
          createdAt,
        )

      const insertPosting = this.db.prepare(
        'INSERT INTO postings (entry_id, account_id, side, amount, seq) VALUES (?, ?, ?, ?, ?)',
      )
      draft.postings.forEach((posting, index) => {
        insertPosting.run(id, posting.accountId, posting.side, posting.amount, index + 1)
      })
    })

    return this.entry(id) as Entry
  }

  /**
   * 冲正：生成一笔方向完全相反的等价分录，而不是修改原分录。
   * 原分录保持不可变，审计链完整；同一个 id 会被部分唯一索引挡住第二次冲正。
   */
  reverse(entryId: string, options: { memo?: string; occurredAt?: string } = {}): Entry {
    return withTx(this.db, () => {
      const original = this.entry(entryId)
      if (!original) throw new InvalidEntryError(`分录不存在：${entryId}`)
      if (original.reversalOf) throw new InvalidEntryError('冲正分录不能再被冲正')
      if (this.findReversal(entryId)) throw new AlreadyReversedError(entryId)

      const postings = original.postings.map((posting) => ({
        accountId: posting.accountId,
        side: opposite(posting.side),
        amount: posting.amount,
      }))

      return this.post({
        currency: original.currency,
        postings,
        memo: options.memo ?? `冲正 ${entryId}`,
        externalRef: original.externalRef ?? undefined,
        transferId: original.transferId ?? undefined,
        occurredAt: options.occurredAt ?? nowIso(),
        reversalOf: entryId,
      })
    })
  }

  findReversal(entryId: string): Entry | undefined {
    const row = this.db
      .prepare('SELECT * FROM journal_entries WHERE reversal_of = ?')
      .get(entryId) as EntryRow | undefined
    return row ? this.hydrate(row) : undefined
  }

  entry(entryId: string): Entry | undefined {
    const row = this.db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(entryId) as
      | EntryRow
      | undefined
    return row ? this.hydrate(row) : undefined
  }

  entriesByTransfer(transferId: string): Entry[] {
    const rows = this.db
      .prepare('SELECT * FROM journal_entries WHERE transfer_id = ? ORDER BY created_at, id')
      .all(transferId) as EntryRow[]
    return rows.map((row) => this.hydrate(row))
  }

  totals(accountId: string): { debits: number; credits: number } {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN side = 'DEBIT'  THEN amount END), 0) AS debits,
           COALESCE(SUM(CASE WHEN side = 'CREDIT' THEN amount END), 0) AS credits
         FROM postings WHERE account_id = ?`,
      )
      .get(accountId) as { debits: number; credits: number }
    return { debits: row.debits, credits: row.credits }
  }

  balance(accountId: string): Balance {
    const account = this.accountById(accountId)
    const { debits, credits } = this.totals(accountId)
    return {
      accountId,
      currency: account.currency,
      minor: balanceOf(account.type, debits, credits),
      normalSide: NORMAL_SIDE[account.type],
    }
  }

  /** 某科目在某方向上的流水，供对账匹配用。 */
  statement(accountId: string, options: { side?: Side } = {}): StatementLine[] {
    const rows = this.db
      .prepare(
        `SELECT p.entry_id, p.side, p.amount, e.occurred_at, e.external_ref
         FROM postings p
         JOIN journal_entries e ON e.id = p.entry_id
         WHERE p.account_id = ? AND (? IS NULL OR p.side = ?)
         ORDER BY e.occurred_at, p.id`,
      )
      .all(accountId, options.side ?? null, options.side ?? null) as Array<{
      entry_id: string
      side: Side
      amount: number
      occurred_at: string
      external_ref: string | null
    }>

    return rows
      .filter((row) => row.external_ref !== null)
      .map((row) => ({
        entryId: row.entry_id,
        externalRef: row.external_ref as string,
        amount: row.amount,
        occurredAt: row.occurred_at,
        side: row.side,
      }))
  }

  /** 试算平衡：全部科目借贷合计应相等，不等说明账被写坏了。 */
  trialBalance(): Array<{ code: string; type: AccountType; debits: number; credits: number; minor: number }> {
    const rows = this.db
      .prepare(
        `SELECT a.code, a.type,
                COALESCE(SUM(CASE WHEN p.side = 'DEBIT'  THEN p.amount END), 0) AS debits,
                COALESCE(SUM(CASE WHEN p.side = 'CREDIT' THEN p.amount END), 0) AS credits
         FROM accounts a
         LEFT JOIN postings p ON p.account_id = a.id
         GROUP BY a.id
         ORDER BY a.code`,
      )
      .all() as Array<{ code: string; type: AccountType; debits: number; credits: number }>

    return rows.map((row) => ({
      code: row.code,
      type: row.type,
      debits: row.debits,
      credits: row.credits,
      minor: balanceOf(row.type, row.debits, row.credits),
    }))
  }

  private hydrate(row: EntryRow): Entry {
    const postings = this.db
      .prepare('SELECT id, entry_id, account_id, side, amount, seq FROM postings WHERE entry_id = ? ORDER BY seq')
      .all(row.id) as PostingRow[]

    return {
      id: row.id,
      occurredAt: row.occurred_at,
      currency: row.currency as Currency,
      memo: row.memo,
      externalRef: row.external_ref,
      transferId: row.transfer_id,
      reversalOf: row.reversal_of,
      fingerprint: row.fingerprint,
      createdAt: row.created_at,
      postings: postings.map((posting) => ({
        id: posting.id,
        accountId: posting.account_id,
        side: posting.side,
        amount: posting.amount,
        seq: posting.seq,
      })),
    }
  }
}
