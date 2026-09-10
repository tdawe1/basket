import { createApp } from "./server/app.ts";
import { genericServerErrorResponse } from "./server/http-error.ts";
import { fromD1 } from "./server/sql-d1.ts";
import { ensureSchema, type Sql } from "./server/sql.ts";

// D1 relies on `wrangler d1 migrations apply`, but an existing database that
// predates the reminders/notes migrations would otherwise return empty lists
// and fail every write. Self-heal once per isolate so the new features work
// even if the migrations were never applied.
let schemaEnsured = false;

async function ensureSchemaOnce(sql: Sql): Promise<void> {
  if (schemaEnsured) return;
  await ensureSchema(sql);
  schemaEnsured = true;
}

const app = createApp(async (c) => {
  const sql = fromD1(c.env.DB as Parameters<typeof fromD1>[0]);
  await ensureSchemaOnce(sql);
  return sql;
});

export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: unknown) {
    try {
      return await app.fetch(request, env, ctx as never);
    } catch {
      return genericServerErrorResponse();
    }
  },
};
