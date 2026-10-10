/**
 * Headed capture of the voucher-wallet page's own POST body for
 * /api/v2/voucher_wallet/get_user_voucher_list. Writes primitives only
 * (gitignored). Does not print values, cookies, or voucher codes.
 * Cloudflare Worker cannot run Chrome.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { chromium, type BrowserContext } from "playwright";

import {
  acquireLock,
  chromiumExecutable,
  ensureRuntimeDirs,
  hasSessionCookie,
  packageRoot,
  releaseLock,
  toPasteBundle,
  type BrowserCookie,
} from "./runtime";

const WALLET_URL = "https://shopee.co.id/user/voucher-wallet";
const LIST_PATH = "/api/v2/voucher_wallet/get_user_voucher_list";
const WAIT_MS = 90_000;

const BODY_KEYS = [
  "addition",
  "cursor",
  "exclude_user_voucher_list_type",
  "limit",
  "need_statistics",
  "priority_voucher_list",
  "show_red_dot",
  "version",
  "voucher_sort_flag",
  "voucher_status",
] as const;

const FORBIDDEN = new Set([
  "cookie",
  "authorization",
  "x-csrftoken",
  "csrftoken",
  "x-csrf-token",
  "set-cookie",
  "_oft",
  "list_type",
]);

function asBrowserCookies(
  cookies: Array<{ name: string; value: string; domain: string; path: string; expires: number }>,
): BrowserCookie[] {
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
  }));
}

function isForbiddenKey(key: string): boolean {
  const n = key.toLowerCase();
  return FORBIDDEN.has(n) || n.startsWith("af-ac");
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function assertInteger(key: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${key} expected integer`);
  }
  return value;
}

function pickCapturedBody(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("voucher.list body is not a JSON object");
  }
  const src = raw as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if (isForbiddenKey(key)) throw new Error(`rejected key ${key}`);
  }
  const out: Record<string, unknown> = {};
  for (const key of BODY_KEYS) {
    if (!(key in src)) throw new Error(`missing ${key}`);
    const value = src[key];
    switch (key) {
      case "cursor":
        if (typeof value !== "string") throw new Error(`${key} expected string`);
        out[key] = value;
        break;
      case "need_statistics":
      case "show_red_dot":
        if (typeof value !== "boolean") throw new Error(`${key} expected boolean`);
        out[key] = value;
        break;
      case "addition":
      case "exclude_user_voucher_list_type":
        if (!Array.isArray(value)) throw new Error(`${key} expected array`);
        out[key] = value;
        break;
      case "priority_voucher_list":
        if (value !== null && !Array.isArray(value)) throw new Error(`${key} expected array or null`);
        out[key] = value;
        break;
      default:
        out[key] = assertInteger(key, value);
    }
  }
  return out;
}

async function main(): Promise<void> {
  if (process.platform !== "darwin" && process.env.AUTH_HEADED !== "1") {
    process.stderr.write(
      "voucher:capture-body is Darwin headed (or AUTH_HEADED=1). Cloudflare Worker cannot run Chrome.\n",
    );
    process.exitCode = 1;
    return;
  }

  const paths = await ensureRuntimeDirs();
  await acquireLock(paths.lockPath);
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(paths.profileDir, {
      headless: false,
      executablePath: chromiumExecutable(chromium.executablePath()),
      viewport: { width: 1280, height: 720 },
      acceptDownloads: true,
    });
    const cookies = await context.cookies();
    const bundle = toPasteBundle(asBrowserCookies(cookies));
    if (!hasSessionCookie(bundle)) {
      process.stderr.write("No SPC_EC/SPC_ST in the Playwright profile. Run `bun run auth` first.\n");
      process.exitCode = 1;
      return;
    }

    const page = context.pages()[0] ?? (await context.newPage());
    const pending = page.waitForRequest((req) => {
      try {
        return req.method() === "POST" && new URL(req.url()).pathname === LIST_PATH;
      } catch {
        return false;
      }
    }, { timeout: WAIT_MS });

    await page.goto(WALLET_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (page.url().includes("/buyer/login")) {
      process.stderr.write("Voucher page redirected to login. Run `bun run auth` first.\n");
      process.exitCode = 1;
      return;
    }

    const request = await pending;
    const captured = pickCapturedBody(request.postDataJSON());
    const captureDir = path.join(packageRoot(), ".runtime", "capture");
    await fs.mkdir(captureDir, { recursive: true, mode: 0o700 });
    const outPath = path.join(captureDir, "voucher-list-body.json");
    await fs.writeFile(outPath, `${JSON.stringify(captured)}\n`, { mode: 0o600 });

    const types = BODY_KEYS.map((key) => `${key}:${jsonType(captured[key])}`).join(" ");
    process.stdout.write(
      `CAPTURED keys=${BODY_KEYS.length} ${types} (saved ${path.relative(process.cwd(), outPath)}; values not printed).\n`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "voucher body capture failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    releaseLock(paths.lockPath);
  }
}

void main();
