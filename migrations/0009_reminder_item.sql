-- reminders.item_id is owned by ensureSchema (src/server/sql.ts), which every
-- backend runs with a tolerant ALTER. Kept as a marker so the migration chain
-- stays sequential; see 0008_sections.sql for the same pattern.
SELECT 1;
