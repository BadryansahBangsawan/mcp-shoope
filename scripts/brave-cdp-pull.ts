/**
 * Attach to a already-running Brave with --remote-debugging-port (copied
 * profile, no Playwright launch flags). Pulls buyer purchases, captures
 * voucher.list POST primitives, POSTs snapshot to Worker. Does not print
 * cookies, order PII, or voucher values. Does not paste a cookie jar.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { chromium, type Page } from "playwright";

import { listItemsFromPage, MAX_SNAPSHOT_DETAILS, MAX_SNAPSHOT_ORDERS, orderIdOf } from "../src/orders/snapshot";
import { importOrdersToWorker } from "./paste-to-worker";
import { acquireLock, ensureRuntimeDirs, packageRoot, releaseLock, workerBase, writeAtomic } from "./runtime";

const CDP = process.env.SHOPEE_CDP_URL ?? "http://127.0.0.1:9333";
const PURCHASE_URL = "https://shopee.co.id/user/purchase";
const WALLET_URL = "https://shopee.co.id/user/voucher-wallet";
const LIST_PATH = "/api/v4/order/get_all_order_and_checkout_list";
const DETAIL_PATH = "/api/v4/order/get_order_detail";
const VOUCHER_PATH = "/api/v2/voucher_wallet/get_user_voucher_list";
const PAGE_SIZE = 20;

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
      const err = result.json && typeof result.json === "object" ? (result.json as { error?: unknown }).error : undefined;
      throw new Error(`orders.list failed HTTP ${result.status} error=${String(err)}`);
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

async function main(): Promise<void> {
  const paths = await ensureRuntimeDirs();
  await acquireLock(paths.lockPath);
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    browser = await chromium.connectOverCDP(CDP);
    const context = browser.contexts()[0];
    if (!context) throw new Error(`no CDP context at ${CDP}`);
    const cookies = await context.cookies("https://shopee.co.id");
    if (!cookies.some((c) => c.name === "SPC_EC")) {
      throw new Error("CDP Brave has no SPC_EC — copied profile did not mount a session");
    }
    const pages = context.pages();
    const page =
      pages.find((p) => p.url().includes("/user/purchase")) ??
      pages.find((p) => p.url().includes("shopee.co.id")) ??
      pages[0] ??
      (await context.newPage());
    const urlNow = page.url();
    if (urlNow.includes("/verify/captcha") || urlNow.includes("/buyer/login")) {
      throw new Error("Copied profile hit login/captcha; relaunch vanilla Brave without Playwright goto");
    }
    if (!urlNow.includes("shopee.co.id")) {
      throw new Error(`expected a shopee.co.id tab, got ${new URL(urlNow).hostname}`);
    }

    // Do not page.goto — CDP goto trips scene=crawler_item. In-page clicks only.
    if (!urlNow.includes("/user/purchase")) {
      await page.evaluate(() => {
        const a = [...document.querySelectorAll("a")].find((el) =>
          (el.getAttribute("href") || "").includes("/user/purchase"),
        );
        a?.click();
      });
      await page.waitForURL(/\/user\/purchase/, { timeout: 15_000 }).catch(() => undefined);
    }
    if (!page.url().includes("/user/purchase") && !page.url().includes("/user/voucher-wallet")) {
      throw new Error(`expected /user/purchase, got ${new URL(page.url()).pathname}`);
    }

    let extraHeaders: Record<string, string> = {};
    const list = await pullList(page, extraHeaders);
    if (!list.length) {
      throw new Error("orders.list parsed 0 items from the in-page XHR");
    }
    const ids: string[] = [];
    for (const item of list) {
      const id = orderIdOf(item);
      if (id && !ids.includes(id)) ids.push(id);
    }
    const details = await pullDetails(page, ids, extraHeaders);
    // Slim list cards to order_id so POST /connect/orders-import stays under CF body limits.
    const snapshot = {
      v: 1 as const,
      source: "browser-export" as const,
      pulledAt: Date.now(),
      list: ids.map((id) => ({ order_id: id })),
      details,
    };
    await writeAtomic(paths.ordersSnapshotPath, `${JSON.stringify(snapshot)}\n`);
    process.stdout.write(
      `PULLED list=${list.length} details=${Object.keys(details).length} ` +
        `(saved ${path.relative(process.cwd(), paths.ordersSnapshotPath)}; values not printed).\n`,
    );

    const pendingVoucher = page.waitForRequest(
      (req) => {
        try {
          return req.method() === "POST" && new URL(req.url()).pathname === VOUCHER_PATH;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    );
    await page.evaluate(() => {
      const a = [...document.querySelectorAll("a")].find((el) =>
        (el.getAttribute("href") || "").includes("/user/voucher-wallet"),
      );
      a?.click();
    });
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
    const message = err instanceof Error ? err.message : "brave-cdp-pull failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    // Disconnect Playwright's CDP client only — does not kill the copied Brave.
    if (browser) await browser.close().catch(() => undefined);
    releaseLock(paths.lockPath);
  }
}

void main();
