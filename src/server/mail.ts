// Node-only SMTP mailer (raw sockets, zero deps). This module must only be
// imported lazily from Node code paths (see /api/share/email): Cloudflare
// Workers and Vercel cannot open SMTP sockets.
import net from "node:net";
import tls from "node:tls";

export type MailConfig = {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure: boolean;
};

export function mailConfig(env: Record<string, string | undefined>): MailConfig | undefined {
  const host = (env.SMTP_HOST ?? "").trim();
  const user = (env.SMTP_USER ?? "").trim();
  const pass = env.SMTP_PASS ?? "";
  if (!host || !user || !pass) return undefined;
  const port = Number(env.SMTP_PORT ?? (env.SMTP_SECURE === "true" ? 465 : 587));
  if (!Number.isFinite(port) || port <= 0) return undefined;
  const from = (env.SMTP_FROM ?? "").trim() || user;
  return { host, port, user, pass, from, secure: env.SMTP_SECURE === "true" || port === 465 };
}

function encodeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

export function buildMessage(from: string, to: string, subject: string, text: string): string {
  const safe = text.replace(/\r?\n\./g, "\n..");
  return [
    `From: ${encodeHeader(from)}`,
    `To: ${encodeHeader(to)}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    safe,
  ].join("\r\n");
}

function readLine(socket: net.Socket | tls.TLSSocket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("SMTP timed out."));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    }
    function onData(chunk: Buffer) {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\r\n");
      if (idx >= 0) {
        const line = buf.slice(0, idx);
        cleanup();
        resolve(line);
      }
    }
    function onError(err: Error) {
      cleanup();
      reject(err);
    }
    function onClose() {
      cleanup();
      reject(new Error("SMTP connection closed."));
    }
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function command(socket: net.Socket | tls.TLSSocket, line: string, expect: number): Promise<void> {
  socket.write(`${line}\r\n`);
  for (;;) {
    const res = await readLine(socket, 15000);
    // Multiline replies use "250-"; the last line uses "250 ".
    if (/^\d{3} /.test(res)) {
      if (Number(res.slice(0, 3)) !== expect) throw new Error("SMTP rejected the message.");
      return;
    }
    if (!/^\d{3}-/.test(res)) throw new Error("SMTP gave an unexpected reply.");
  }
}

function connectPlain(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
    setTimeout(() => reject(new Error("SMTP timed out.")), 15000).unref?.();
  });
}

export async function sendMail(
  cfg: MailConfig,
  opts: { to: string; subject: string; text: string },
): Promise<void> {
  let socket: net.Socket | tls.TLSSocket = cfg.secure
    ? tls.connect(cfg.port, cfg.host, { servername: cfg.host })
    : await connectPlain(cfg.host, cfg.port);
  try {
    const greet = await readLine(socket, 15000);
    if (!greet.startsWith("220")) throw new Error("SMTP did not greet.");
    await command(socket, `EHLO ${cfg.host}`, 250);
    if (!cfg.secure) {
      await command(socket, "STARTTLS", 220);
      socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const upgraded = tls.connect({ socket: socket as net.Socket, servername: cfg.host });
        upgraded.once("secureConnect", () => resolve(upgraded));
        upgraded.once("error", reject);
      });
      await command(socket, `EHLO ${cfg.host}`, 250);
    }
    await command(socket, "AUTH LOGIN", 334);
    await command(socket, Buffer.from(cfg.user, "utf8").toString("base64"), 334);
    await command(socket, Buffer.from(cfg.pass, "utf8").toString("base64"), 235);
    await command(socket, `MAIL FROM:<${cfg.user}>`, 250);
    await command(socket, `RCPT TO:<${opts.to}>`, 250);
    await command(socket, "DATA", 354);
    socket.write(buildMessage(cfg.from, opts.to, opts.subject, opts.text) + "\r\n.\r\n");
    const done = await readLine(socket, 15000);
    if (!done.startsWith("250")) throw new Error("SMTP rejected the message.");
    socket.write("QUIT\r\n");
  } finally {
    socket.destroy();
  }
}
