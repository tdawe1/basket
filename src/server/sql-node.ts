import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ensureSchema, type Sql, type SqlValue } from "./sql.ts";

export function fromNode(db: DatabaseSync): Sql {
  return {
    async exec(sql: string) {
      db.exec(sql);
    },
    async run(sql: string, ...params: SqlValue[]) {
      db.prepare(sql).run(...params);
    },
    async get<T>(sql: string, ...params: SqlValue[]) {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    async all<T>(sql: string, ...params: SqlValue[]) {
      return db.prepare(sql).all(...params) as T[];
    },
  };
}

export async function openNodeSql(path: string): Promise<Sql> {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  const sql = fromNode(db);
  await ensureSchema(sql);
  return sql;
}
