CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sections_list ON sections(list_id, sort_order);

ALTER TABLE items ADD COLUMN section_id TEXT NOT NULL DEFAULT '';
