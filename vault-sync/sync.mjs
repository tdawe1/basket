// vault-sync sidecar: pulls the Proton Pass vault via pass-cli and pushes a
// cache into Basket through POST /api/vault/sync. Plain node, zero deps.
// Env: PROTON_PASS_PERSONAL_ACCESS_TOKEN (required), PROTON_PASS_VAULT
// (default Shared), PASS_CLI_BIN (default pass-cli), SYNC_URL (required,
// e.g. http://basket:3000/api/vault/sync), VAULT_SYNC_SECRET (required),
// SYNC_INTERVAL_S (default 300), SYNC_ONCE (set to 1 for a single run).
import { execFile } from "node:child_process";

function env(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value ? value : fallback;
}

function runCli(bin, args, token, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PROTON_PASS_PERSONAL_ACCESS_TOKEN: token } },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr ?? "").trim().slice(0, 300) || String(error.message ?? error).slice(0, 300)));
          return;
        }
        resolve(String(stdout ?? ""));
      },
    );
  });
}

async function syncOnce() {
  const token = env("PROTON_PASS_PERSONAL_ACCESS_TOKEN");
  const vault = env("PROTON_PASS_VAULT", "Shared");
  const bin = env("PASS_CLI_BIN", "pass-cli");
  const url = env("SYNC_URL");
  const secret = env("VAULT_SYNC_SECRET");
  if (!token) throw new Error("PROTON_PASS_PERSONAL_ACCESS_TOKEN is required.");
  if (!url) throw new Error("SYNC_URL is required.");
  if (!secret) throw new Error("VAULT_SYNC_SECRET is required.");
  const out = await runCli(bin, ["item", "list", "--vault-name", vault, "--output", "json", "--show-secrets"], token);
  const parsed = JSON.parse(out);
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-vault-sync-secret": secret },
    body: JSON.stringify({ vault, items }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Sync push failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const body = await res.json().catch(() => ({}));
  console.log(`vault-sync: pushed ${body.updated ?? items.length} items for vault "${vault}".`);
}

function missingConfig() {
  if (!env("PROTON_PASS_PERSONAL_ACCESS_TOKEN")) return "PROTON_PASS_PERSONAL_ACCESS_TOKEN is required.";
  if (!env("SYNC_URL")) return "SYNC_URL is required.";
  if (!env("VAULT_SYNC_SECRET")) return "VAULT_SYNC_SECRET is required.";
  return null;
}

async function main() {
  // Idle (don't crash-loop under `restart: unless-stopped`) until configured.
  const intervalS = Math.max(60, Number(env("SYNC_INTERVAL_S", "300")) || 300);
  if (env("SYNC_ONCE") === "1") {
    const missing = missingConfig();
    if (missing) throw new Error(missing);
    await syncOnce();
    return;
  }
  for (;;) {
    const missing = missingConfig();
    if (missing) {
      console.log(`vault-sync: not configured (${missing}); rechecking in ${intervalS}s.`);
    } else {
      try {
        await syncOnce();
      } catch (error) {
        console.error(`vault-sync: ${error instanceof Error ? error.message : error}`);
      }
      console.log(`vault-sync: next sync in ${intervalS}s.`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalS * 1000));
  }
}

main().catch((error) => {
  console.error(`vault-sync: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
