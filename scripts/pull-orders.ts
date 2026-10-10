/**
 * Headed pull of buyer purchase history from this machine. POSTs a snapshot
 * (not cookies) to Worker /connect/orders-import. Does not print order PII
 * or cookie values. Cloudflare Worker fetch still 403s these XHRs.
 */
import path from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright";

import { listItemsFromPage, MAX_SNAPSHOT_DETAILS, MAX_SNAPSHOT_ORDERS, orderIdOf } from "../src/orders/snapshot";
import { importOrdersToWorker } from "./paste-to-worker";
import {
  acquireLock,
  chromiumExecutable,
  ensureRuntimeDirs,
  hasSessionCookie,
  releaseLock,
  toPasteBundle,
  workerBase,
  writeAtomic,
  type BrowserCookie,
} from "./runtime";

const PURCHASE_URL = "https://shopee.co.id/user/purchase";
const LIST_PATH = "/api/v4/order/get_all_order_and_checkout_list";
const DETAIL_PATH = "/api/v4/order/get_order_detail";
const PAGE_SIZE = 20;

type FetchResult = { status: number; json: unknown };

const SKIP_CAPTURED_HEADERS = new Set([
  "cookie",
  "host",
  "content-length",
  "connection",
  "accept-encoding",
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

/** Copy the purchase page's own XHR headers. Do not mint af-ac-enc-* / _oft. */
function capturedHeaderBag(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SKIP_CAPTURED_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
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

async function pullList(
  page: Page,
  extraHeaders: Record<string, string>,
  seed: unknown[] = [],
): Promise<unknown[]> {
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

async function main(): Promise<void> {
  if (process.platform !== "darwin" && process.env.AUTH_HEADED !== "1") {
    process.stderr.write("orders:pull is Darwin headed (or AUTH_HEADED=1). Cloudflare Worker cannot run Chrome.\n");
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
    const pendingList = page.waitForResponse((res) => isApiPath(res.url(), LIST_PATH), { timeout: 60_000 });
    await page.goto(PURCHASE_URL, { waitUntil: "load", timeout: 60_000 });
    if (page.url().includes("/buyer/login")) {
      process.stderr.write("Purchase page redirected to login. Run `bun run auth` first.\n");
      process.exitCode = 1;
      return;
    }

    let extraHeaders: Record<string, string> = {};
    let seed: unknown[] = [];
    try {
      const first = await pendingList;
      extraHeaders = capturedHeaderBag(first.request().headers());
      if (first.status() === 401 || first.status() === 403) {
        throw new Error(
          `orders.list HTTP ${first.status()} from the page's own XHR. Run \`bun run auth\` first.`,
        );
      }
      if (first.ok()) {
        const json: unknown = await first.json().catch(() => null);
        if (envelopeOk(json)) seed = listItemsFromPage(json);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("bun run auth")) throw err;
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

    if (process.env.SHOPEE_AUTH_SKIP_PASTE === "1") {
      process.stdout.write("SHOPEE_AUTH_SKIP_PASTE=1 — not posting snapshot to Worker.\n");
      return;
    }
    const base = workerBase();
    const imported = await importOrdersToWorker(snapshot, base);
    process.stdout.write(
      `IMPORT_OK ${base} listCount=${imported.listCount ?? list.length} detailCount=${imported.detailCount ?? Object.keys(details).length}\n`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "orders pull failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    releaseLock(paths.lockPath);
  }
}

void main();
