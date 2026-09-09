CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  list_id TEXT REFERENCES lists(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'trip',
  title TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 60,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reminders_household ON reminders(household_id, due_at);
