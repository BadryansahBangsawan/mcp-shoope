/**
 * Sidecar paths and helpers for headed Shopee login on this machine.
 * Cloudflare Worker cannot run Chrome.
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { isBuyerShopeeDomain } from "../src/dispatcher/allowlist";
import { SESSION_COOKIE_NAMES } from "../src/connect/cookie-jar";

/** Official QR page (observed href `/buyer/login/qr` on GET /buyer/login). Sidecar only — not a Worker hop. */
export const LOGIN_URL = "https://shopee.co.id/buyer/login/qr";
export const LOGIN_FALLBACK_URL = "https://shopee.co.id/buyer/login";
export const DEFAULT_WORKER = "https://mcp.shopee.badry.engineer";

export type BrowserCookie = {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
};

export type PasteBundle = {
  v: 1;
  source: "browser-export";
  cookies: Array<{ name: string; value: string; domain: string; path: string; expires?: number }>;
};

export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function runtimePaths(root = packageRoot()) {
  const runtimeDir = path.join(root, ".runtime");
  const authDir = path.join(runtimeDir, "auth");
  return {
    runtimeDir,
    authDir,
    profileDir: path.join(authDir, "pw-profile"),
    pastePath: path.join(authDir, "paste-tokens.json"),
    authMetaPath: path.join(authDir, "meta.json"),
    cookieNamesPath: path.join(authDir, "cookie-names.txt"),
    operatorDonePath: path.join(authDir, "operator-done"),
    lockPath: path.join(authDir, "lock"),
  };
}

export type RuntimePaths = ReturnType<typeof runtimePaths>;

export async function ensureRuntimeDirs(): Promise<RuntimePaths> {
  const p = runtimePaths();
  await fsPromises.mkdir(p.authDir, { recursive: true, mode: 0o700 });
  return p;
}

export async function writeAtomic(filePath: string, contents: string, mode = 0o600): Promise<void> {
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fsPromises.writeFile(tmp, contents, { mode });
  await fsPromises.rename(tmp, filePath);
  await fsPromises.chmod(filePath, mode);
}

export function loadDevVars(root = packageRoot()): Record<string, string> {
  const file = path.join(root, ".dev.vars");
  if (!fs.existsSync(file)) throw new Error(".dev.vars missing — copy .dev.vars.example and fill OWNER_PASSWORD");
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trim().startsWith("#")) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** Production Worker by default. Override with SHOPEE_MCP_BASE for wrangler local. */
export function workerBase(): string {
  const fromEnv = process.env.SHOPEE_MCP_BASE?.replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  return DEFAULT_WORKER;
}

export function toPasteBundle(cookies: BrowserCookie[]): PasteBundle {
  const kept = cookies.filter((c) => isBuyerShopeeDomain(c.domain) && c.name && typeof c.value === "string");
  return {
    v: 1,
    source: "browser-export",
    cookies: kept.map((c) => {
      const row: PasteBundle["cookies"][number] = {
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

export function hasSessionCookie(bundle: { cookies: Array<{ name: string }> }): boolean {
  const names: readonly string[] = SESSION_COOKIE_NAMES;
  return bundle.cookies.some((c) => names.includes(c.name));
}

export function cookieNamesLine(bundle: { cookies: Array<{ name: string }> }): string {
  return [...new Set(bundle.cookies.map((c) => c.name))].sort().join(", ");
}

export function chromiumExecutable(bundled: string): string {
  if (fs.existsSync(bundled)) return bundled;
  const root = path.join(os.homedir(), "Library/Caches/ms-playwright");
  if (!fs.existsSync(root)) return bundled;
  const dirs = fs
    .readdirSync(root)
    .filter((d) => d.startsWith("chromium-") && !d.includes("headless"))
    .sort()
    .reverse();
  for (const d of dirs) {
    const exe = path.join(
      root,
      d,
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    );
    if (fs.existsSync(exe)) return exe;
  }
  return bundled;
}

export async function acquireLock(lockPath: string): Promise<void> {
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeSync(fd, `${process.pid}\n`);
    fs.closeSync(fd);
  } catch {
    throw new Error(`Capture already running (lock ${lockPath}).`);
  }
}

export function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // no lock
  }
}

export async function waitForEnterOrDone(
  donePath: string,
  timeoutMs: number,
): Promise<"enter" | "done" | "timeout"> {
  return new Promise((resolve) => {
    let settled = false;
    let rl: ReturnType<typeof createInterface> | undefined;
    const finish = (outcome: "enter" | "done" | "timeout") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      rl?.close();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    const poll = setInterval(() => {
      if (fs.existsSync(donePath)) finish("done");
    }, 1000);
    // Non-TTY (background job) must not treat EOF as Enter before login.
    if (process.stdin.isTTY) {
      rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question("", () => finish("enter"));
    }
  });
}
