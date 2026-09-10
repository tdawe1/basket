import type { Sql, SqlValue } from "./sql.ts";

type D1Like = {
  exec(sql: string): Promise<unknown>;
  prepare(sql: string): {
    bind(...params: SqlValue[]): {
      run(): Promise<unknown>;
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results?: T[] }>;
    };
  };
};

export function fromD1(db: D1Like): Sql {
  return {
    async exec(sql: string) {
      // The D1 worker binding's exec() rejects multi-line/multi-statement
      // strings that node:sqlite, libSQL, and the D1 HTTP API all accept
      // (D1_EXEC_ERROR ... incomplete input). Run each statement through
      // the prepared-statement path, which handles them reliably.
      for (const stmt of splitStatements(sql)) {
        await db.prepare(stmt).bind().run();
      }
    },
    async run(sql: string, ...params: SqlValue[]) {
      await db
        .prepare(sql)
        .bind(...params)
        .run();
    },
    async get<T>(sql: string, ...params: SqlValue[]) {
      const row = await db
        .prepare(sql)
        .bind(...params)
        .first<T>();
      return row ?? undefined;
    },
    async all<T>(sql: string, ...params: SqlValue[]) {
      const result = await db
        .prepare(sql)
        .bind(...params)
        .all<T>();
      return result.results ?? [];
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
}

function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      cur += ch;
      if (ch === quote) {
        // '' and "" are escaped quotes inside a string literal.
        if (sql[i + 1] === quote) {
          cur += sql[i + 1];
          i++;
        } else {
          quote = null;
        }
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === ";") {
      if (cur.trim()) out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}
