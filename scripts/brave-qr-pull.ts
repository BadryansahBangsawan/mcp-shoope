/**
 * Headed Brave (separate user-data-dir) QR login → orders snapshot import
 * + voucher.list POST body capture. Does not print cookies, order PII, or
 * voucher values. Does not paste a new cookie jar (Worker-IP 403 is not a
 * missing-cookie problem). Cloudflare Worker cannot run Chrome.
 *
 * Used when the live Brave profile cannot be driven (Apple Events JS off)
 * and Chromium-for-Testing does not mount /user/purchase.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright";

import { listItemsFromPage, MAX_SNAPSHOT_DETAILS, MAX_SNAPSHOT_ORDERS, orderIdOf } from "../src/orders/snapshot";
import { importOrdersToWorker } from "./paste-to-worker";
import {
  LOGIN_FALLBACK_URL,
  LOGIN_URL,
  acquireLock,
  ensureRuntimeDirs,
  packageRoot,
  releaseLock,
  workerBase,
  writeAtomic,
} from "./runtime";

const BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const PURCHASE_URL = "https://shopee.co.id/user/purchase";
const WALLET_URL = "https://shopee.co.id/user/voucher-wallet";
const LIST_PATH = "/api/v4/order/get_all_order_and_checkout_list";
const DETAIL_PATH = "/api/v4/order/get_order_detail";
const VOUCHER_PATH = "/api/v2/voucher_wallet/get_user_voucher_list";
const PAGE_SIZE = 20;
const QR_TIMEOUT_MS = 20 * 60 * 1000;

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

const SKIP_CAPTURED_HEADERS = new Set([
  "cookie",
  "host",
  "content-length",
  "connection",
  "accept-encoding",
]);

type FetchResult = { status: number; json: unknown };

function envelopeOk(json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  const e = (json as { error?: unknown }).error;
  return e === 0 || e === "0" || e === "" || e === null || e === undefined;
}

function isApiPath(url: string, apiPath: string): boolean {
  try {
    return new URL(url).pathname === apiPath;
  } catch {
    return false;
  }
}

function capturedHeaderBag(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SKIP_CAPTURED_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isForbiddenKey(key: string): boolean {
  const n = key.toLowerCase();
  return FORBIDDEN.has(n) || n.startsWith("af-ac");
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
        if (typeof value !== "number" || !Number.isInteger(value)) {
          throw new Error(`${key} expected integer`);
        }
        out[key] = value;
    }
  }
  return out;
}

async function pageGet(
  page: Page,
  apiPath: string,
  query: Record<string, string>,
  extraHeaders: Record<string, string> = {},
): Promise<FetchResult> {
  return page.evaluate(
    async ({ apiPath, query, origin, extraHeaders }) => {
      const url = new URL(apiPath, origin);
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
      const headers: Record<string, string> = {
        accept: "application/json",
        "x-api-source": "pc",
        "x-requested-with": "XMLHttpRequest",
        "x-shopee-language": "id",
        ...extraHeaders,
      };
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "x-csrftoken")) {
        const m = document.cookie.match(/(?:^|; )csrftoken=([^;]*)/);
        if (m?.[1]) headers["x-csrftoken"] = decodeURIComponent(m[1]);
      }
      const res = await fetch(url.toString(), {
        method: "GET",
        credentials: "include",
        headers,
      });
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, json };
    },
    { apiPath, query, origin: "https://shopee.co.id", extraHeaders },
  );
}

async function pullList(page: Page, extraHeaders: Record<string, string>, seed: unknown[] = []): Promise<unknown[]> {
  const list: unknown[] = [...seed];
  let offset = list.length;
  while (list.length < MAX_SNAPSHOT_ORDERS) {
    const limit = Math.min(PAGE_SIZE, MAX_SNAPSHOT_ORDERS - list.length);
    const result = await pageGet(page, LIST_PATH, { limit: String(limit), offset: String(offset) }, extraHeaders);
    if (result.status === 403 || result.status === 401) {
      if (list.length) break;
      throw new Error(`orders.list HTTP ${result.status} from the local browser (not a Worker IP issue)`);
    }
    if (result.status !== 200 || !envelopeOk(result.json)) {
      if (list.length) break;
      throw new Error(`orders.list failed HTTP ${result.status}`);
    }
    const items = listItemsFromPage(result.json);
    if (!items.length) break;
    list.push(...items);
    offset += items.length;
    if (items.length < limit) break;
  }
  return list.slice(0, MAX_SNAPSHOT_ORDERS);
}

async function pullDetails(
  page: Page,
  ids: string[],
  extraHeaders: Record<string, string>,
): Promise<Record<string, unknown>> {
  const details: Record<string, unknown> = {};
  for (const id of ids.slice(0, MAX_SNAPSHOT_DETAILS)) {
    const result = await pageGet(page, DETAIL_PATH, { order_id: id }, extraHeaders);
    if (result.status === 403 || result.status === 401) {
      if (Object.keys(details).length) break;
      throw new Error(`orders.detail HTTP ${result.status} from the local browser`);
    }
    if (result.status !== 200 || !envelopeOk(result.json)) continue;
    details[id] = result.json;
  }
  return details;
}

async function dismissLanguage(page: Page): Promise<void> {
  const btn = page.getByRole("button", { name: /Bahasa Indonesia|Indonesian/i });
  try {
    await btn.first().waitFor({ state: "visible", timeout: 20_000 });
    await btn.first().click({ timeout: 5_000 });
    await btn.first().waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
  } catch {
    // overlay already gone, or first-run dialog never appeared
  }
}

/** Page's own "Muat Ulang Kode QR" control — not a Worker hop. */
async function reloadQrIfNeeded(page: Page): Promise<void> {
  const expired = page.getByText(/Kode QR Tidak Berlaku|QR code expired|Mohon muat ulang/i);
  const reload = page.getByRole("button", { name: /Muat Ulang Kode QR|Reload QR/i });
  const visible =
    ((await expired.count()) > 0 && (await expired.first().isVisible().catch(() => false))) ||
    ((await reload.count()) > 0 && (await reload.first().isVisible().catch(() => false)));
  if (!visible) return;
  if ((await reload.count()) > 0) {
    await reload.first().click({ timeout: 3_000 }).catch(() => undefined);
  }
}

async function openQr(page: Page): Promise<void> {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await dismissLanguage(page);
  for (const name of ["Lanjutkan", "Mengerti"]) {
    const btn = page.getByRole("button", { name });
    if ((await btn.count()) > 0) {
      await btn.first().click({ timeout: 3_000 }).catch(() => undefined);
    }
  }
  const qrLink = page.locator('a[href="/buyer/login/qr"]');
  if ((await qrLink.count()) > 0) {
    await qrLink.first().click({ timeout: 5_000 }).catch(() => undefined);
  } else if (!page.url().includes("/buyer/login/qr")) {
    await page.goto(LOGIN_FALLBACK_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await dismissLanguage(page);
    const fallback = page.locator('a[href="/buyer/login/qr"]');
    if ((await fallback.count()) > 0) {
      await fallback.first().click({ timeout: 5_000 }).catch(() => undefined);
    }
  }
  await dismissLanguage(page);
  await reloadQrIfNeeded(page);
}

async function waitForSpcEc(context: BrowserContext, page: Page, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  let lastReload = 0;
  while (Date.now() - start < timeoutMs) {
    const cookies = await context.cookies("https://shopee.co.id");
    if (cookies.some((c) => c.name === "SPC_EC")) return true;
    const now = Date.now();
    if (now - lastReload > 15_000) {
      lastReload = now;
      await dismissLanguage(page);
      await reloadQrIfNeeded(page);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

async function main(): Promise<void> {
  if (process.platform !== "darwin" && process.env.AUTH_HEADED !== "1") {
    process.stderr.write("brave-qr-pull is Darwin headed (or AUTH_HEADED=1).\n");
    process.exitCode = 1;
    return;
  }

  const paths = await ensureRuntimeDirs();
  await acquireLock(paths.lockPath);
  const profileDir = path.join(paths.authDir, "brave-qr-profile");
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });

  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      executablePath: BRAVE,
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true,
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await openQr(page);
    process.stdout.write(
      "Brave opened the official Shopee QR page. Scan it in the Shopee app (Scan QR → Konfirmasi Log in).\n" +
        "Waiting for SPC_EC (not SPC_ST). Timeout 20 minutes. Cookie values not printed.\n",
    );
    const ok = await waitForSpcEc(context, page, QR_TIMEOUT_MS);
    if (!ok) {
      process.stderr.write("Timed out waiting for SPC_EC.\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write("SPC_EC present. Pulling purchases (values not printed).\n");

    const pendingList = page.waitForResponse((res) => isApiPath(res.url(), LIST_PATH), { timeout: 60_000 });
    await page.goto(PURCHASE_URL, { waitUntil: "load", timeout: 60_000 });
    if (page.url().includes("/buyer/login")) {
      process.stderr.write("Purchase page redirected to login after QR.\n");
      process.exitCode = 1;
      return;
    }

    let extraHeaders: Record<string, string> = {};
    let seed: unknown[] = [];
    try {
      const first = await pendingList;
      extraHeaders = capturedHeaderBag(first.request().headers());
      if (first.status() === 401 || first.status() === 403) {
        throw new Error(`orders.list HTTP ${first.status()} from the page's own XHR.`);
      }
      if (first.ok()) {
        const json: unknown = await first.json().catch(() => null);
        if (envelopeOk(json)) seed = listItemsFromPage(json);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("orders.list HTTP")) throw err;
    }

    const list = await pullList(page, extraHeaders, seed);
    const ids: string[] = [];
    for (const item of list) {
      const id = orderIdOf(item);
      if (id && !ids.includes(id)) ids.push(id);
    }
    const details = await pullDetails(page, ids, extraHeaders);
    const snapshot = {
      v: 1 as const,
      source: "browser-export" as const,
      pulledAt: Date.now(),
      list,
      details,
    };
    await writeAtomic(paths.ordersSnapshotPath, `${JSON.stringify(snapshot)}\n`);
    process.stdout.write(
      `PULLED list=${list.length} details=${Object.keys(details).length} ` +
        `(saved ${path.relative(process.cwd(), paths.ordersSnapshotPath)}; values not printed).\n`,
    );

    const pendingVoucher = page.waitForRequest((req) => {
      try {
        return req.method() === "POST" && new URL(req.url()).pathname === VOUCHER_PATH;
      } catch {
        return false;
      }
    }, { timeout: 90_000 });
    await page.goto(WALLET_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    try {
      const request = await pendingVoucher;
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
      process.stderr.write(`voucher capture skipped: ${message}\n`);
    }

    const base = workerBase();
    const imported = await importOrdersToWorker(snapshot, base);
    process.stdout.write(
      `IMPORT_OK ${base} listCount=${imported.listCount ?? list.length} detailCount=${imported.detailCount ?? Object.keys(details).length}\n`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "brave-qr-pull failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    releaseLock(paths.lockPath);
  }
}

void main();
