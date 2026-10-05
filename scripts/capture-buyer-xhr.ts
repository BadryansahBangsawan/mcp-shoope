/**
 * Attach to the headed Brave debug port and record keys-only XHR/fetch from
 * shopee.co.id. Never writes cookie/CSRF/token values.
 *
 *   bun run scripts/capture-buyer-xhr.ts
 *
 * Stop with Ctrl+C. Snapshot: .runtime/capture/xhr-keys.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DEBUG_PORT = Number(process.env.SHOPEE_CDP_PORT || 9333);
const OUT = resolve(process.cwd(), ".runtime/capture/xhr-keys.json");
const FLUSH_MS = 2_000;

const SKIP_TYPE = new Set([
  "Document",
  "Stylesheet",
  "Image",
  "Media",
  "Font",
  "Script",
  "Manifest",
  "Preflight",
  "Ping",
  "CSPViolationReport",
]);

type Hit = {
  method: string;
  host: string;
  path: string;
  queryKeys: string[];
  status?: number;
  resourceType?: string;
  requestHeaderNames: string[];
  responseHeaderNames: string[];
  requestBodyKeys: string[];
  responseBodyKeys: string[];
  count: number;
};

const hits = new Map<string, Hit>();
const pending = new Map<string, { method: string; url: string; type?: string; postData?: string }>();
let seq = 0;
const waiters = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function isBuyerHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h.includes("partner")) return false;
  // Seller Centre host is dropped for most paths; buyer ChatEasy mini-chat
  // on pcmall still calls seller.shopee.co.id/webchat/* (recorded, not dispatched).
  if (h === "seller.shopee.co.id" || h.endsWith(".seller.shopee.co.id")) return true;
  if (h === "seller-push-ws.shopee.co.id") return true;
  return h === "shopee.co.id" || h.endsWith(".shopee.co.id") || h === "shopeemobile.com" || h.endsWith(".shopeemobile.com");
}

function jsonKeys(raw: unknown, depth = 0, out: string[] = []): string[] {
  if (!raw || typeof raw !== "object" || depth > 2) return out;
  if (Array.isArray(raw)) {
    if (raw.length) jsonKeys(raw[0], depth, out);
    return out;
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!out.includes(k)) out.push(k);
    jsonKeys(v, depth + 1, out);
  }
  return out;
}

function parseMaybeJson(text: string | undefined): string[] {
  if (!text) return [];
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return [];
  try {
    return jsonKeys(JSON.parse(t));
  } catch {
    return [];
  }
}

function headerNames(headers: unknown): string[] {
  if (!headers || typeof headers !== "object") return [];
  return Object.keys(headers as Record<string, string>)
    .map((n) => n.toLowerCase())
    .filter((n) => n !== "cookie" && n !== "set-cookie" && n !== "authorization")
    .sort();
}

function fingerprint(method: string, host: string, path: string): string {
  return `${method} ${host} ${path}`;
}

function upsert(partial: Omit<Hit, "count">): Hit {
  const id = fingerprint(partial.method, partial.host, partial.path);
  const prev = hits.get(id);
  if (!prev) {
    const next = { ...partial, count: 1 };
    hits.set(id, next);
    console.log(`XHR ${id}`);
    return next;
  }
  prev.count += 1;
  const merge = (a: string[], b: string[]) => [...new Set([...a, ...b])].sort();
  prev.queryKeys = merge(prev.queryKeys, partial.queryKeys);
  prev.requestHeaderNames = merge(prev.requestHeaderNames, partial.requestHeaderNames);
  prev.responseHeaderNames = merge(prev.responseHeaderNames, partial.responseHeaderNames);
  prev.requestBodyKeys = merge(prev.requestBodyKeys, partial.requestBodyKeys);
  prev.responseBodyKeys = merge(prev.responseBodyKeys, partial.responseBodyKeys);
  if (partial.status) prev.status = partial.status;
  return prev;
}

function noteRequest(p: {
  requestId: string;
  sessionId?: string;
  type?: string;
  request: { method: string; url: string; headers?: unknown; postData?: string };
}): void {
  if (p.type && SKIP_TYPE.has(p.type)) return;
  let url: URL;
  try {
    url = new URL(p.request.url);
  } catch {
    return;
  }
  if (url.protocol !== "https:" || !isBuyerHost(url.hostname)) return;
  pending.set(`${p.sessionId || ""}:${p.requestId}`, {
    method: p.request.method.toUpperCase(),
    url: p.request.url,
    type: p.type,
    postData: p.request.postData,
  });
}

function noteResponse(p: {
  requestId: string;
  sessionId?: string;
  type?: string;
  response: { url: string; status: number; headers?: unknown };
}): void {
  const key = `${p.sessionId || ""}:${p.requestId}`;
  const req = pending.get(key);
  const rawUrl = req?.url || p.response.url;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return;
  }
  if (url.protocol !== "https:" || !isBuyerHost(url.hostname)) return;
  const type = p.type || req?.type;
  if (type && SKIP_TYPE.has(type)) return;
  upsert({
    method: (req?.method || "GET").toUpperCase(),
    host: url.hostname,
    path: url.pathname,
    queryKeys: [...url.searchParams.keys()].sort(),
    status: p.response.status,
    resourceType: type,
    requestHeaderNames: [],
    responseHeaderNames: headerNames(p.response.headers),
    requestBodyKeys: parseMaybeJson(req?.postData),
    responseBodyKeys: [],
  });
}

function attachBody(sessionId: string | undefined, requestId: string, body: string, base64: boolean): void {
  const key = `${sessionId || ""}:${requestId}`;
  const req = pending.get(key);
  if (!req) return;
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  const text = base64 ? Buffer.from(body, "base64").toString("utf8") : body;
  const keys = parseMaybeJson(text);
  if (!keys.length) return;
  upsert({
    method: req.method,
    host: url.hostname,
    path: url.pathname,
    queryKeys: [...url.searchParams.keys()].sort(),
    requestHeaderNames: [],
    responseHeaderNames: [],
    requestBodyKeys: parseMaybeJson(req.postData),
    responseBodyKeys: keys,
  });
}

function flush(): void {
  mkdirSync(resolve(process.cwd(), ".runtime/capture"), { recursive: true });
  const rows = [...hits.values()].sort((a, b) => fingerprint(a.method, a.host, a.path).localeCompare(fingerprint(b.method, b.host, b.path)));
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        unique: rows.length,
        endpoints: rows,
      },
      null,
      2,
    ) + "\n",
  );
}

async function main() {
  const version = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()) as {
    Browser?: string;
    webSocketDebuggerUrl?: string;
  };
  if (!/Chrome|Chromium|Brave|Edg/i.test(version.Browser ?? "") || !version.webSocketDebuggerUrl) {
    throw new Error(`No headed Chromium on :${DEBUG_PORT}`);
  }

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("browser CDP websocket failed")), { once: true });
  });

  const call = (method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`CDP timeout ${method}`));
      }, 10_000);
      waiters.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  };

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data)) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message: string };
      sessionId?: string;
    };
    if (msg.id && waiters.has(msg.id)) {
      const w = waiters.get(msg.id)!;
      waiters.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message));
      else w.resolve(msg.result);
      return;
    }
    const sessionId = msg.sessionId;
    const p = msg.params || {};
    if (msg.method === "Target.attachedToTarget") {
      const info = p.sessionId as string | undefined;
      const targetInfo = p.targetInfo as { type?: string } | undefined;
      const sid = info;
      if (!sid) return;
      if (targetInfo?.type === "page" || targetInfo?.type === "iframe") {
        void (async () => {
          await call("Network.enable", { maxTotalBufferSize: 50_000_000, maxResourceBufferSize: 5_000_000 }, sid);
          await call("Network.setCacheDisabled", { cacheDisabled: true }, sid);
        })().catch((err) => console.log("attach:", err instanceof Error ? err.message : err));
      }
      return;
    }
    if (msg.method === "Network.requestWillBeSent") {
      noteRequest({
        requestId: String(p.requestId),
        sessionId,
        type: p.type as string | undefined,
        request: p.request as { method: string; url: string; headers?: unknown; postData?: string },
      });
      return;
    }
    if (msg.method === "Network.responseReceived") {
      noteResponse({
        requestId: String(p.requestId),
        sessionId,
        type: p.type as string | undefined,
        response: p.response as { url: string; status: number; headers?: unknown },
      });
      return;
    }
    if (msg.method === "Network.loadingFinished") {
      const requestId = String(p.requestId);
      const key = `${sessionId || ""}:${requestId}`;
      if (!pending.has(key)) return;
      void call("Network.getResponseBody", { requestId }, sessionId)
        .then((r) => {
          const body = r as { body?: string; base64Encoded?: boolean };
          if (typeof body.body === "string") attachBody(sessionId, requestId, body.body, Boolean(body.base64Encoded));
        })
        .catch(() => undefined);
      return;
    }
    if (msg.method === "Network.webSocketCreated") {
      const urlRaw = String(p.url || "");
      let url: URL;
      try {
        url = new URL(urlRaw);
      } catch {
        return;
      }
      if (!isBuyerHost(url.hostname)) return;
      upsert({
        method: "WS",
        host: url.hostname,
        path: url.pathname,
        queryKeys: [...url.searchParams.keys()].sort(),
        resourceType: "WebSocket",
        requestHeaderNames: [],
        responseHeaderNames: [],
        requestBodyKeys: [],
        responseBodyKeys: [],
      });
    }
  });

  await call("Target.setDiscoverTargets", { discover: true });
  await call("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });

  const targets = (await call("Target.getTargets")) as {
    targetInfos: Array<{ targetId: string; type: string; url: string }>;
  };
  const shopeePages = targets.targetInfos.filter((t) => {
    if (t.type !== "page") return false;
    try {
      const u = new URL(t.url);
      return isBuyerHost(u.hostname);
    } catch {
      return false;
    }
  });
  console.log(`CAPTURING tabs=${shopeePages.length} — browse Shopee, I record XHR keys only`);
  for (const t of shopeePages) {
    const attached = (await call("Target.attachToTarget", { targetId: t.targetId, flatten: true })) as { sessionId: string };
    await call("Network.enable", { maxTotalBufferSize: 50_000_000, maxResourceBufferSize: 5_000_000 }, attached.sessionId);
    await call("Network.setCacheDisabled", { cacheDisabled: true }, attached.sessionId);
    await call("Page.reload", { ignoreCache: true }, attached.sessionId).catch(() => undefined);
    console.log(`RELOAD ${t.url.replace(/[?#].*$/, "")}`);
  }

  setInterval(() => {
    flush();
    console.log(`SNAPSHOT unique=${hits.size} file=.runtime/capture/xhr-keys.json`);
  }, FLUSH_MS);

  process.on("SIGINT", () => {
    flush();
    console.log(`DONE unique=${hits.size}`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
