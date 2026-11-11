-- 账务库 schema（SQLite，最小闭环）
-- 设计原则：
--   1) 分录与 posting 只追加（append-only），没有 UPDATE 路径；
--   2) 金额全部 INTEGER，单位是分；
--   3) 约束尽量下沉到表结构（CHECK / UNIQUE / 部分索引），应用层校验只做「好错误信息」。

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  currency   TEXT NOT NULL DEFAULT 'CNY',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id           TEXT PRIMARY KEY,
  occurred_at  TEXT NOT NULL,
  currency     TEXT NOT NULL,
  memo         TEXT NOT NULL DEFAULT '',
  external_ref TEXT,
  transfer_id  TEXT,
  reversal_of  TEXT REFERENCES journal_entries (id),
  fingerprint  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_external_ref ON journal_entries (external_ref);
CREATE INDEX IF NOT EXISTS idx_entries_transfer ON journal_entries (transfer_id);

-- 一笔分录最多被冲正一次：靠部分唯一索引兜住，而不是靠应用层「先查再写」。
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_reversal_unique
  ON journal_entries (reversal_of)
  WHERE reversal_of IS NOT NULL;

CREATE TABLE IF NOT EXISTS postings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id   TEXT NOT NULL REFERENCES journal_entries (id),
  account_id TEXT NOT NULL REFERENCES accounts (id),
  side       TEXT NOT NULL CHECK (side IN ('DEBIT', 'CREDIT')),
  amount     INTEGER NOT NULL CHECK (amount > 0),
  seq        INTEGER NOT NULL,
  UNIQUE (entry_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_postings_account ON postings (account_id);

CREATE TABLE IF NOT EXISTS transfers (
  id           TEXT PRIMARY KEY,
  status       TEXT NOT NULL CHECK (status IN ('CREATED', 'AUTHORIZED', 'POSTED', 'SETTLED', 'FAILED', 'REVERSED')),
  currency     TEXT NOT NULL,
  amount       INTEGER NOT NULL CHECK (amount > 0),
  fee          INTEGER NOT NULL DEFAULT 0 CHECK (fee >= 0),
  wallet_id    TEXT NOT NULL REFERENCES accounts (id),
  merchant_id  TEXT NOT NULL REFERENCES accounts (id),
  updated_at   TEXT NOT NULL
);

-- 状态迁移留痕：出问题时能回答「谁在什么时候把它推到这一步」，而不是只有最终态。
CREATE TABLE IF NOT EXISTS transfer_status_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id TEXT NOT NULL REFERENCES transfers (id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  at          TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  response    TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
