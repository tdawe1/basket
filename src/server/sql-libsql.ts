import { ensureSchema, type Sql, type SqlValue } from "./sql.ts";

type LibsqlClient = {
  execute(stmt: { sql: string; args: SqlValue[] }): Promise<{ rows: unknown[] }>;
  executeMultiple(sql: string): Promise<unknown>;
};

export function fromLibsql(client: LibsqlClient): Sql {
  return {
    async exec(sql: string) {
      await client.executeMultiple(sql);
    },
    async run(sql: string, ...params: SqlValue[]) {
      await client.execute({ sql, args: params });
    },
    async get<T>(sql: string, ...params: SqlValue[]) {
      const result = await client.execute({ sql, args: params });
      return (result.rows[0] as T | undefined) ?? undefined;
    },
    async all<T>(sql: string, ...params: SqlValue[]) {
      const result = await client.execute({ sql, args: params });
      return result.rows as T[];
    },
  };
}

export async function openLibsql(url: string, authToken?: string): Promise<Sql> {
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url, authToken });
  const sql = fromLibsql(client);
  await ensureSchema(sql);
  return sql;
}
