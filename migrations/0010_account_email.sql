-- users.email is owned by ensureSchema (src/server/sql.ts), which every backend
-- runs with a tolerant ALTER; see 0008_sections.sql for the pattern. No
-- statement needed here.

-- External cloud-storage links (scaffold): one row per household+provider.
-- status is pending until a real provider flow completes; the Basket-hosted
-- file browser in the Storage section works without any link.
CREATE TABLE IF NOT EXISTS cloud_links (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  account_email TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (household_id, provider)
);
