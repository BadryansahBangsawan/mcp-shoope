/**
 * End-to-end check of a running shopee-mcp Worker (local `wrangler dev` or production).
 *
 *   bun run scripts/e2e-mcp.ts --base http://localhost:8787
 *   bun run scripts/e2e-mcp.ts --base https://mcp.shopee.badry.engineer --live
 *   bun run scripts/e2e-mcp.ts --base http://localhost:8787 --connect --live
 *     --connect first signs in as owner and POSTs cookie JSON from
 *     SHOPEE_E2E_PASTE (JSON string) or .runtime/auth/paste-tokens.json.
 *     Seller Centre login is never attempted. GET /connect/login is 404.
 *     SSO/Open Platform hops (/connect/sso, /connect/authorize) are 410.
 *
 * Runs the real OAuth 2.1 flow (DCR → /authorize consent with owner password → PKCE token
 * exchange), then drives /mcp with the official MCP v2 client pinned to 2026-07-28.
 * Reads OWNER_PASSWORD from the environment, falling back to .dev.vars. Never prints secrets.
 * Never calls mutating operations.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};

const BASE = opt("base", "http://localhost:8787").replace(/\/$/, "");
const LIVE = flag("live");
const REDIRECT_URI = "http://localhost:53682/callback";
const PROTOCOL = "2026-07-28";
const READ_SCOPE = "shopee:read";

function devVars(): Record<string, string> {
  const path = resolve(process.cwd(), ".dev.vars");
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trim().startsWith("#")) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const VARS = devVars();
const OWNER_PASSWORD = process.env.OWNER_PASSWORD?.trim() || VARS.OWNER_PASSWORD || "";
const CONNECT = flag("connect");

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

function cookiesFrom(res: Response): string {
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

async function oauthToken(scope: string): Promise<string> {
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json() as { resource: string };
  check("protected resource metadata", prm.resource === `${BASE}/mcp`, prm.resource);
  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
  check("authorization server metadata (S256, CIMD, DCR)",
    JSON.stringify(as.code_challenge_methods_supported) === '["S256"]' &&
    as.client_id_metadata_document_supported === true && typeof as.registration_endpoint === "string");

  const reg = await fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "shopee-e2e", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
  });
  const client = (await reg.json()) as { client_id: string };
  check("dynamic client registration", reg.status === 201 && Boolean(client.client_id), `status ${reg.status}`);

  const { verifier, challenge } = await pkce();
  const state = crypto.randomUUID();
  const authUrl = new URL(`${BASE}/authorize`);
  for (const [k, v] of Object.entries({
    response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT_URI, scope, state,
    code_challenge: challenge, code_challenge_method: "S256", resource: `${BASE}/mcp`,
  })) authUrl.searchParams.set(k, v);

  const page = await fetch(authUrl, { redirect: "manual" });
  const html = await page.text();
  const csrf = /name="csrf" value="([a-f0-9]{32})"/.exec(html)?.[1] ?? "";
  const cookie = cookiesFrom(page);
  check("consent page renders with CSRF", page.status === 200 && Boolean(csrf) && Boolean(cookie));
  check("consent page anti-framing", page.headers.get("x-frame-options") === "DENY");

  const post = (body: Record<string, string>, withCookie = cookie) =>
    fetch(authUrl, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: withCookie },
      body: new URLSearchParams(body),
    });

  const noCsrf = await post({ decision: "approve", scope: READ_SCOPE, password: OWNER_PASSWORD }, "");
  check("consent rejects missing CSRF", noCsrf.status === 403, `status ${noCsrf.status}`);
  const wrong = await post({ csrf, decision: "approve", scope: READ_SCOPE, password: "definitely-not-the-password" });
  check("consent rejects wrong owner password", wrong.status === 401, `status ${wrong.status}`);

  const approved = await post({ csrf, decision: "approve", scope: READ_SCOPE, password: OWNER_PASSWORD });
  const location = approved.headers.get("location") ?? "";
  const cb = location ? new URL(location) : null;
  check("consent approves with owner password", approved.status === 302 && cb?.searchParams.get("state") === state,
    `status ${approved.status}`);
  const code = cb?.searchParams.get("code") ?? "";

  const tokenRes = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: client.client_id,
      code_verifier: verifier, resource: `${BASE}/mcp`,
    }),
  });
  const token = (await tokenRes.json()) as { access_token?: string; scope?: string; refresh_token?: string };
  check("PKCE token exchange", tokenRes.ok && Boolean(token.access_token), `scope=${token.scope ?? "?"}`);

  const refreshRes = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: token.refresh_token ?? "", client_id: client.client_id, resource: `${BASE}/mcp`,
    }),
  });
  const refreshed = (await refreshRes.json()) as { access_token?: string };
  check("refresh token rotation", refreshRes.ok && Boolean(refreshed.access_token));
  return refreshed.access_token ?? token.access_token ?? "";
}

class Jar {
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

function loadPasteBundle(): unknown {
  const inline = process.env.SHOPEE_E2E_PASTE?.trim();
  if (inline) return JSON.parse(inline);
  const path = resolve(process.cwd(), ".runtime/auth/paste-tokens.json");
  if (!existsSync(path)) throw new Error("SHOPEE_E2E_PASTE or .runtime/auth/paste-tokens.json required for --connect");
  return JSON.parse(readFileSync(path, "utf8"));
}

async function connectPasteSession(): Promise<void> {
  const jar = new Jar();
  const loginPage = await fetch(`${BASE}/login?next=/connect`, { redirect: "manual" });
  jar.absorb(loginPage);
  const csrf = /name="csrf" value="([a-f0-9]{32})"/.exec(await loginPage.text())?.[1] ?? "";
  const login = await fetch(`${BASE}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: new URLSearchParams({ csrf, next: "/connect", password: OWNER_PASSWORD }),
  });
  jar.absorb(login);
  check("owner sign-in for /connect", login.status === 302 && login.headers.get("location") === "/connect");

  const loginHop = await fetch(`${BASE}/connect/login`, {
    headers: { cookie: jar.header() },
  });
  check("GET /connect/login is 404 (not a hop)", loginHop.status === 404, `status ${loginHop.status}`);

  const sso = await fetch(`${BASE}/connect/sso`, {
    headers: { accept: "application/json", cookie: jar.header() },
  });
  const ssoBody = (await sso.json()) as { code?: string; message?: string };
  check("/connect/sso is 410 with HP/email copy",
    sso.status === 410 && /HP\/email/i.test(ssoBody.message ?? ""),
    `status ${sso.status}`);

  const connectPage = await fetch(`${BASE}/connect`, { headers: { cookie: jar.header() } });
  jar.absorb(connectPage);
  const connectCsrf = /name="csrf" value="([a-f0-9]{32})"/.exec(await connectPage.text())?.[1] ?? csrf;

  const bundle = loadPasteBundle();
  const paste = await fetch(`${BASE}/connect/paste`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", cookie: jar.header() },
    body: JSON.stringify({ csrf: connectCsrf, bundle }),
  });
  const pasted = (await paste.json()) as Record<string, unknown>;
  check("paste cookie bundle via /connect/paste", paste.ok && pasted.connected === true,
    pasted.connected ? `source=${String(pasted.source)} cookieCount=${String(pasted.cookieCount)}` : `status ${paste.status}`);
  check("paste JSON never returns cookies", !Object.prototype.hasOwnProperty.call(pasted, "cookies"));

  const status = (await (await fetch(`${BASE}/connect/status`, { headers: { accept: "application/json", cookie: jar.header() } })).json()) as Record<string, unknown>;
  const dumped = JSON.stringify(status);
  check("/connect/status connected (no secrets in payload)",
    status.connected === true &&
      !Object.prototype.hasOwnProperty.call(status, "cookies") &&
      !/access_token=|refresh_token=|partner_key=|&sign=|SPC_EC=/i.test(dumped),
    `source=${String(status.source)} cookieCount=${String(status.cookieCount)}`);
}

async function connect(token: string, mode: "modern" | "legacy"): Promise<Client> {
  const client = new Client(
    { name: "shopee-e2e", version: "1.0.0" },
    { versionNegotiation: { mode: mode === "modern" ? { pin: PROTOCOL } : "legacy" } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

async function main() {
  console.log(`E2E against ${BASE}${LIVE ? " (live read-only Shopee calls)" : ""}`);
  if (!OWNER_PASSWORD) throw new Error("OWNER_PASSWORD not set (env or .dev.vars)");

  const health = await fetch(`${BASE}/healthz`);
  check("GET /healthz", health.ok);

  const anon = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("unauthenticated /mcp → 401 + resource_metadata",
    anon.status === 401 && (anon.headers.get("www-authenticate") ?? "").includes("resource_metadata="));
  const bogus = await fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: "Bearer not-a-token" }, body: "{}" });
  check("invalid bearer → 401", bogus.status === 401);
  const connectAnon = await fetch(`${BASE}/connect`, { redirect: "manual" });
  check("/connect requires owner sign-in", connectAnon.status === 302 &&
    (connectAnon.headers.get("location") ?? "").startsWith("/login"));

  if (CONNECT) await connectPasteSession();
  const token = await oauthToken(READ_SCOPE);
  const client = await connect(token, "modern");
  check("server/discover negotiated 2026-07-28", client.getNegotiatedProtocolVersion() === PROTOCOL,
    client.getNegotiatedProtocolVersion());

  const tools = (await client.listTools()).tools;
  const names = tools.map((t) => t.name).sort();
  check("tools/list (read-only token)", JSON.stringify(names) === '["execute","search"]', names.join(","));
  check("tools annotated readOnlyHint + title", tools.every((t) => t.annotations?.readOnlyHint === true && Boolean(t.title)));
  check("execute_mutation not listed while ENABLE_MUTATIONS=false", !names.includes("execute_mutation"));

  const listedResources = (await client.listResources()).resources;
  const resources = listedResources.map((r) => r.uri);
  check("resources/list", ["shopee://docs/index", "shopee://openapi", "shopee://capabilities", "shopee://coverage"].every((u) => resources.includes(u)), resources.join(","));
  check("resources/list has no ui:// widget views", !resources.some((u) => u.startsWith("ui://")));
  const templates = (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
  check("resources/templates/list", templates.some((t) => t.includes("shopee://docs/")), templates.join(","));
  const openapi = await client.readResource({ uri: "shopee://openapi" });
  const openapiText = (openapi.contents[0] as { text?: string }).text ?? "";
  check("resources/read shopee://openapi", openapiText.includes('"openapi"'));
  check("openapi has no credentials", !/partner_key=|access_token=|refresh_token=|&sign=/i.test(openapiText));

  const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
  check("prompts/list", JSON.stringify(prompts) === '["detail-pesanan","ringkas-akun","riwayat-beli"]', prompts.join(","));

  const search = await client.callTool({
    name: "search",
    arguments: { code: "async () => { const { catalog } = await codemode.spec(); return catalog.map(o => o.operationId); }" },
  });
  check("tools/call search (empty catalog until HAR)", !search.isError && toolText(search).trim() === "[]", toolText(search).slice(0, 120));

  const escape = await client.callTool({
    name: "execute",
    arguments: { code: "async () => { const r = await fetch('https://example.com'); return r.status; }" },
  });
  check("sandbox blocks outbound fetch", escape.isError === true || !/\b200\b/.test(toolText(escape)), toolText(escape).slice(0, 160));

  const write = await client.callTool({
    name: "execute",
    arguments: { code: "async () => codemode.request({ operationId: 'orders.cancel', body: { order_sn: 'x' } })" },
  });
  check("execute refuses unknown/mutating operations", write.isError === true, toolText(write).slice(0, 160));
  const hidden = await client.callTool({ name: "execute_mutation", arguments: { operationId: "orders.cancel" } }).catch((e: Error) => e);
  check("execute_mutation not callable with a read-only token",
    hidden instanceof Error || (hidden as { isError?: boolean }).isError === true);

  if (LIVE) {
    const live = await client.callTool({
      name: "execute",
      arguments: {
        code: `async () => {
  const { catalog } = await codemode.spec();
  if (!catalog.length) return { catalog: [] };
  const first = await codemode.request({ operationId: catalog[0].operationId });
  return { status: first.status, keys: Object.keys(first.data ?? {}).slice(0, 8) };
}`,
      },
    });
    const liveText = toolText(live);
    check("live catalog empty until HAR (or first observed read)",
      !live.isError && (liveText.includes('"catalog":[]') || liveText.includes('"status":200')),
      liveText.slice(0, 240));
    const unregistered = await client.callTool({
      name: "execute",
      arguments: { code: "async () => codemode.request({ operationId: 'account.profile' })" },
    });
    check("unregistered reads are UNSUPPORTED until HAR", unregistered.isError === true, toolText(unregistered).slice(0, 160));
    check("live read does not return HTML login", !/buyer\/login|sign[\s-]?in/i.test(liveText));
    check("live read does not leak cookies", !/SPC_EC|csrftoken|access_token|refresh_token|partner_key/i.test(liveText));
  }
  await client.close();

  try {
    const legacy = await connect(token, "legacy");
    const legacyTools = (await legacy.listTools()).tools.length;
    console.log(`INFO  legacy (2025 initialize) client connected, ${legacyTools} tools (MCP_LEGACY_MODE=stateless)`);
    await legacy.close();
  } catch (err) {
    console.log(`INFO  legacy (2025 initialize) client rejected: ${(err as Error).message.slice(0, 160)}`);
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
