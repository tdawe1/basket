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
      await db.exec(sql);
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
