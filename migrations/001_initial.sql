CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'admin')),
  user_id INTEGER,
  username_snapshot TEXT,
  email_snapshot TEXT,
  csrf_secret TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  username_snapshot TEXT,
  email_snapshot TEXT,
  amount_fen INTEGER NOT NULL CHECK (
    typeof(amount_fen) = 'integer'
    AND amount_fen > 0
    AND amount_fen <= 9007199254740991
  ),
  balance_value TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  trade_no TEXT UNIQUE,
  paid_at TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'awaiting_payment', 'pending_review', 'processing', 'approved',
    'rejected', 'recharge_failed', 'expired'
  )),
  admin_note TEXT,
  rejection_reason TEXT,
  recharge_code TEXT NOT NULL UNIQUE,
  recharge_attempts INTEGER NOT NULL DEFAULT 0 CHECK (recharge_attempts >= 0),
  last_recharge_error TEXT,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  processing_at TEXT,
  reviewed_at TEXT,
  approved_at TEXT,
  rejected_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(user_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id INTEGER PRIMARY KEY,
  admin_name TEXT NOT NULL,
  action TEXT NOT NULL,
  order_no TEXT,
  old_status TEXT,
  new_status TEXT,
  ip TEXT,
  user_agent TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_order_created
  ON admin_audit_logs(order_no, created_at DESC);
