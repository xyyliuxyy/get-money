ALTER TABLE orders ADD COLUMN external_order_no TEXT;
ALTER TABLE orders ADD COLUMN notify_url TEXT;
ALTER TABLE orders ADD COLUMN return_url TEXT;
ALTER TABLE orders ADD COLUMN external_trade_no TEXT;
ALTER TABLE orders ADD COLUMN callback_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE orders ADD COLUMN callback_attempts INTEGER NOT NULL DEFAULT 0 CHECK (callback_attempts >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_external_order_no
  ON orders(external_order_no)
  WHERE external_order_no IS NOT NULL;
