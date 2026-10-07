/**
 * Brave CDP fallback. Prefer `bun run auth` (Chrome for Testing).
 * Never prints cookie values. Profile lives in .runtime/chrome-shopee (gitignored).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { pasteToWorker } from "./paste-to-worker";
import {
  LOGIN_URL,
  cookieNamesLine,
  hasSessionCookie,
  runtimePaths,
  toPasteBundle,
  workerBase,
  writeAtomic,
} from "./runtime";

const BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const DEBUG_PORT = 9333;
const WORKER = workerBase();
const PROFILE = resolve(process.cwd(), ".runtime/chrome-shopee");
const BUNDLE_PATH = runtimePaths().pastePath;
const WAIT_MS = 15 * 60_000;

type CdpCookie = {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  session?: boolean;
};

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
      console.log("Brave opened on Shopee QR login — scan in the Shopee app");
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

async function main() {
  await launchBrave();
  await ensureLoginTab().catch((err) => {
    console.log("navigate:", err instanceof Error ? err.message : err);
  });
  console.log("WAITING_FOR_LOGIN — finish Shopee login (OTP ok) in the Brave window");

  const started = Date.now();
  let bundle: ReturnType<typeof toPasteBundle> | null = null;
  let lastBeat = 0;
  while (Date.now() - started < WAIT_MS) {
    try {
      const next = toPasteBundle(await readCookies());
      if (hasSessionCookie(next)) {
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
  await writeAtomic(BUNDLE_PATH, JSON.stringify(bundle, null, 2) + "\n");
  console.log(`CAPTURED ${bundle.cookies.length} cookies: ${cookieNamesLine(bundle)}`);

  const pasted = await pasteToWorker(bundle, WORKER);
  console.log(`PASTE_OK ${WORKER} source=${pasted.source} cookieCount=${pasted.cookieCount}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
