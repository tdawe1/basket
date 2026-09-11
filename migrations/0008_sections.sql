CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sections_list ON sections(list_id, sort_order);

-- items.section_id is owned by ensureSchema (src/server/sql.ts), which every
-- backend runs with a tolerant ALTER. An unconditional ALTER TABLE here would
-- fail with a duplicate-column error on any database the self-heal already
-- patched, aborting the migration run.
