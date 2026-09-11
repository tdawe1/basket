CREATE TABLE IF NOT EXISTS vault_items (
  vault TEXT NOT NULL DEFAULT 'Shared',
  id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  item_type TEXT NOT NULL DEFAULT 'unknown',
  state TEXT NOT NULL DEFAULT 'Active',
  note TEXT NOT NULL DEFAULT '',
  fields TEXT NOT NULL DEFAULT '{}',
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (vault, id)
);

CREATE INDEX IF NOT EXISTS idx_vault_items_vault ON vault_items(vault, title);
