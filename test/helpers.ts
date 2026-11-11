/**
 * 测试夹具：一套已建好科目录入初始余额的内存账本。
 * 每个用例独立开库，互不污染。
 */

import { DEBIT } from '../src/domain/accounts.ts'
import type { Account } from '../src/domain/accounts.ts'
import { Ledger } from '../src/ledger/ledger.ts'
import type { Db } from '../src/store/db.ts'
import { createDb } from '../src/store/db.ts'

export interface Fixture {
  db: Db
  ledger: Ledger
  wallet: Account
  payable: Account
  reserve: Account
  feeRevenue: Account
}

export function fixture(initialWalletMinor = 500_00): Fixture {
  const db = createDb(':memory:')
  const ledger = new Ledger(db)

  const wallet = ledger.openAccount({ code: '2001', name: '用户钱包', type: 'LIABILITY' })
  const payable = ledger.openAccount({ code: '2002', name: '商户待结算', type: 'LIABILITY' })
  const reserve = ledger.openAccount({ code: '1002', name: '备付金', type: 'ASSET' })
  const feeRevenue = ledger.openAccount({ code: '4001', name: '手续费收入', type: 'REVENUE' })

  if (initialWalletMinor > 0) {
    ledger.post({
      currency: 'CNY',
      postings: [
        { accountId: reserve.id, side: DEBIT, amount: initialWalletMinor },
        { accountId: wallet.id, side: 'CREDIT', amount: initialWalletMinor },
      ],
      memo: '期初入金',
    })
  }

  return { db, ledger, wallet, payable, reserve, feeRevenue }
}
