import { createApp } from "./server/app.ts";
import { fromD1 } from "./server/sql-d1.ts";

const app = createApp((c) => fromD1(c.env.DB as Parameters<typeof fromD1>[0]));

export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: unknown) {
    try {
      return await app.fetch(request, env, ctx as never);
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },
};
