import { existsSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.ts";
import { openNodeSql } from "./sql-node.ts";

function lanUrls(port: number): string[] {
  const urls: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) {
        urls.push(`http://${addr.address}:${port}`);
      }
    }
  }
  return urls;
}

const dataDir = process.env.DATA_DIR || join(process.cwd(), "data");
const sql = await openNodeSql(join(dataDir, "basket.sqlite"));
const app = createApp(() => sql);

if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: "./dist/client" }));
  app.get("*", serveStatic({ path: "./dist/client/index.html" }));
}

const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOST || "0.0.0.0";

serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`Basket is open at http://127.0.0.1:${port}`);
  if (existsSync("/.dockerenv")) {
    console.log("On your phones, open http://<this-computer's-LAN-IP>:8080 (the published Docker port).");
  } else {
    for (const url of lanUrls(port)) console.log(`On your phones: ${url}`);
  }
});
