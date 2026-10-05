/**
 * Open a dedicated Brave window on shopee.co.id, wait for the operator to
 * log in, then POST the buyer cookies to local /connect/paste.
 *
 *   bun run scripts/capture-buyer-cookies.ts
 *
 * Never prints cookie values. Profile lives in .runtime/chrome-shopee (gitignored).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const DEBUG_PORT = 9333;
const LOGIN_URL = "https://shopee.co.id/buyer/login";
const WORKER = process.env.SHOPEE_MCP_BASE?.replace(/\/$/, "") || "http://127.0.0.1:8787";
const PROFILE = resolve(process.cwd(), ".runtime/chrome-shopee");
const BUNDLE_PATH = resolve(process.cwd(), ".runtime/auth/paste-tokens.json");
const WAIT_MS = 15 * 60_000;
const SESSION_NAMES = new Set(["SPC_EC", "SPC_ST"]);

type CdpCookie = {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  session?: boolean;
};

function loadDevVars(): Record<string, string> {
  const path = resolve(process.cwd(), ".dev.vars");
  if (!existsSync(path)) throw new Error(".dev.vars missing — run setup first");
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trim().startsWith("#")) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function isBuyerDomain(domain: string): boolean {
  const host = domain.replace(/^\./, "").toLowerCase();
  if (host.includes("seller") || host.includes("partner")) return false;
  return host === "shopee.co.id" || host.endsWith(".shopee.co.id");
}

async function debugUp(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return false;
    const info = (await res.json()) as { Browser?: string };
    return /Chrome|Chromium|Brave|Edg/i.test(info.Browser ?? "");
  } catch {
    return false;
  }
}

async function launchBrave(): Promise<void> {
  if (await debugUp()) {
    console.log("Brave debug port already open");
    return;
  }
  if (!existsSync(BRAVE)) throw new Error(`Brave not found at ${BRAVE}`);
  mkdirSync(PROFILE, { recursive: true });
  const child = spawn(
    BRAVE,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--new-window",
      LOGIN_URL,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await debugUp()) {
      console.log("Brave opened on shopee.co.id/buyer/login — log in there");
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Brave did not open a debug port on ${DEBUG_PORT}`);
}

async function listPages(): Promise<Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>> {
  return (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()) as Array<{
    type: string;
    url: string;
    webSocketDebuggerUrl?: string;
  }>;
}

async function debuggerUrl(): Promise<string> {
  const pages = await listPages();
  const page =
    pages.find((p) => p.type === "page" && p.webSocketDebuggerUrl && /shopee\.co\.id/.test(p.url)) ??
    pages.find((p) => p.type === "page" && p.webSocketDebuggerUrl);
  if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
  const version = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()) as {
    webSocketDebuggerUrl?: string;
  };
  if (!version.webSocketDebuggerUrl) throw new Error("No Brave tab with CDP websocket");
  return version.webSocketDebuggerUrl;
}

async function withCdp<T>(fn: (call: <R>(method: string, params?: Record<string, unknown>) => Promise<R>) => Promise<T>): Promise<T> {
  const ws = new WebSocket(await debuggerUrl());
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed")), { once: true });
  });
  let seq = 0;
  const call = <R>(method: string, params?: Record<string, unknown>): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 8_000);
      const onmsg = (ev: MessageEvent) => {
        const msg = JSON.parse(String(ev.data)) as { id?: number; result?: R; error?: { message: string } };
        if (msg.id !== id) return;
        clearTimeout(timer);
        ws.removeEventListener("message", onmsg);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result as R);
      };
      ws.addEventListener("message", onmsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
  try {
    return await fn(call);
  } finally {
    ws.close();
  }
}

async function ensureLoginTab(): Promise<void> {
  const pages = await listPages();
  const onShopee = pages.some((p) => p.type === "page" && /shopee\.co\.id/.test(p.url));
  if (onShopee) return;
  await withCdp(async (call) => {
    await call("Page.enable").catch(() => undefined);
    await call("Page.navigate", { url: LOGIN_URL });
  });
}

async function readCookies(): Promise<CdpCookie[]> {
  return withCdp(async (call) => {
    await call("Network.enable").catch(() => undefined);
    try {
      const r = await call<{ cookies: CdpCookie[] }>("Network.getAllCookies");
      if (Array.isArray(r?.cookies)) return r.cookies;
    } catch {
      /* fall through */
    }
    const r = await call<{ cookies: CdpCookie[] }>("Storage.getCookies");
    return r.cookies ?? [];
  });
}

function toBundle(cookies: CdpCookie[]) {
  const kept = cookies.filter((c) => isBuyerDomain(c.domain) && c.name && typeof c.value === "string");
  return {
    v: 1 as const,
    source: "browser-export" as const,
    cookies: kept.map((c) => {
      const row: { name: string; value: string; domain: string; path: string; expires?: number } = {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path && c.path.startsWith("/") ? c.path : "/",
      };
      if (typeof c.expires === "number" && c.expires > 0 && c.expires < 1e12) row.expires = c.expires;
      else if (typeof c.expires === "number" && c.expires >= 1e12) row.expires = Math.floor(c.expires / 1000);
      return row;
    }),
  };
}

function hasSession(bundle: { cookies: Array<{ name: string }> }): boolean {
  return bundle.cookies.some((c) => SESSION_NAMES.has(c.name));
}

class OwnerJar {
  #cookies = new Map<string, string>();
  absorb(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i);
      const value = pair!.slice(i + 1);
      if (/Max-Age=0/i.test(c) || !value) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function pasteToWorker(bundle: unknown): Promise<{ connected?: boolean; cookieCount?: number; source?: string }> {
  const vars = loadDevVars();
  const password = vars.OWNER_PASSWORD;
  if (!password) throw new Error("OWNER_PASSWORD missing in .dev.vars");
  const jar = new OwnerJar();

  const loginPage = await fetch(`${WORKER}/login?next=/connect`, { redirect: "manual" });
  jar.absorb(loginPage);
  const loginCsrf = /name="csrf" value="([a-f0-9]{32})"/.exec(await loginPage.text())?.[1];
  if (!loginCsrf) throw new Error("owner /login has no CSRF");
  const login = await fetch(`${WORKER}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: new URLSearchParams({ csrf: loginCsrf, next: "/connect", password }),
  });
  jar.absorb(login);
  if (login.status !== 302) throw new Error(`owner login failed (${login.status})`);

  const connectPage = await fetch(`${WORKER}/connect`, { headers: { cookie: jar.header() } });
  jar.absorb(connectPage);
  const connectCsrf = /name="csrf" value="([a-f0-9]{32})"/.exec(await connectPage.text())?.[1];
  if (!connectCsrf) throw new Error("GET /connect has no CSRF");

  const paste = await fetch(`${WORKER}/connect/paste`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      cookie: jar.header(),
    },
    body: JSON.stringify({ csrf: connectCsrf, bundle }),
  });
  const body = (await paste.json()) as Record<string, unknown>;
  if (!paste.ok || body.connected !== true) {
    throw new Error(`paste failed ${paste.status}: ${JSON.stringify({ code: body.code, message: body.message })}`);
  }
  return body as { connected?: boolean; cookieCount?: number; source?: string };
}

async function main() {
  const health = await fetch(`${WORKER}/healthz`);
  if (!health.ok) throw new Error(`Worker not up at ${WORKER}`);

  await launchBrave();
  await ensureLoginTab().catch((err) => {
    console.log("navigate:", err instanceof Error ? err.message : err);
  });
  console.log("WAITING_FOR_LOGIN — finish Shopee login (OTP ok) in the Brave window");

  const started = Date.now();
  let bundle: ReturnType<typeof toBundle> | null = null;
  let lastBeat = 0;
  while (Date.now() - started < WAIT_MS) {
    try {
      const cookies = await readCookies();
      const next = toBundle(cookies);
      if (hasSession(next)) {
        bundle = next;
        break;
      }
    } catch (err) {
      console.log("poll:", err instanceof Error ? err.message : err);
    }
    const elapsed = Date.now() - started;
    if (elapsed - lastBeat >= 30_000) {
      lastBeat = elapsed;
      console.log(`still waiting (${Math.round(elapsed / 1000)}s) — log in to Shopee in Brave`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!bundle) throw new Error("Timed out waiting for SPC_EC/SPC_ST — log in to Shopee in the Brave window");

  mkdirSync(resolve(process.cwd(), ".runtime/auth"), { recursive: true });
  writeFileSync(BUNDLE_PATH, JSON.stringify(bundle, null, 2) + "\n");
  const names = bundle.cookies.map((c) => c.name).sort();
  console.log(`CAPTURED ${bundle.cookies.length} cookies: ${names.join(", ")}`);

  const pasted = await pasteToWorker(bundle);
  console.log(`PASTE_OK source=${pasted.source} cookieCount=${pasted.cookieCount}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
