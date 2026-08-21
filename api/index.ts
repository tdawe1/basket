import { createApp } from "../src/server/app.ts";
import { openLibsql } from "../src/server/sql-libsql.ts";
import type { Sql } from "../src/server/sql.ts";

const url = process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || "";
const token = process.env.TURSO_AUTH_TOKEN || process.env.DATABASE_AUTH_TOKEN;

let cached: Promise<Sql> | null = null;

function getSql(): Promise<Sql> {
  if (!url) {
    throw new Error("Set DATABASE_URL (or TURSO_DATABASE_URL) to a libSQL database for Vercel.");
  }
  if (!cached) cached = openLibsql(url, token);
  return cached;
}

export default createApp(async () => getSql());
