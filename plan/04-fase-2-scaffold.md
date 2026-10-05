# Fase 2 — scaffolding Worker + OAuth

Buat repo baru. Jangan fork buta lalu search-replace; scaffolding bersih lebih aman.

## 2.1 Skeleton

```
package.json
wrangler.jsonc
tsconfig.json
tsconfig.scripts.json
vitest.config.ts
worker-configuration.d.ts
.dev.vars.example
.gitignore
src/index.ts
src/errors/codes.ts
src/observability/log.ts
src/observability/redact.ts
src/auth/scopes.ts
src/auth/owner.ts
src/auth/owner-routes.ts
src/auth/pages.ts
src/auth/verify.ts
src/mcp/server.ts
src/mcp/results.ts
src/mcp/resources.ts
src/mcp/prompts.ts
src/web/html.ts
tests/stubs/*
tests/unit/*
tests/security/*
tests/protocol/*
```

Scripts wajib sejak hari pertama:

```
dev, deploy, deploy:dry-run, check-types, test, lint,
coverage:validate, openapi:validate, docs:bundle, e2e
```

Widget scripts ditambah di fase 7.

`.gitignore` wajib: `node_modules/`, `.dev.vars`, `.wrangler/`, `dist/`, `.env`, `.env.*`, `coverage/`, `*.log`, `.secrets.production`.

## 2.2 `wrangler.jsonc`

Wajib:

- `account_id` akun Cloudflare **Anda** (jangan copy dari repo acuan)
- `main: "src/index.ts"`
- `compatibility_date` + flags `nodejs_compat`, `global_fetch_strictly_public` (SSRF guard untuk fetch CIMD)
- `workers_dev: false`, `preview_urls: false`
- `routes: [{ pattern: "mcp.<domain>", custom_domain: true }]`
- `dev: { ip: "127.0.0.1", port: 8787, local_protocol: "http", upstream_protocol: "http", host: "localhost:8787" }` agar `request.url` tidak di-rewrite ke domain produksi
- `worker_loaders: [{ binding: "LOADER" }]`
- `kv_namespaces: [{ binding: "OAUTH_KV", id: "<kv-baru>" }]`
- Durable Objects SQLite: `<PLATFORM>_SESSIONS`, `MUTATION_APPROVALS`
- `migrations`: tag `v1` dengan `new_sqlite_classes`. **Jangan edit tag yang sudah di-deploy**
- `observability.enabled: true`, `head_sampling_rate: 1`
- `vars`:
  - `PUBLIC_BASE_URL=https://mcp.<domain>`
  - slug tenant, default outlet/branch jika ada
  - `ENABLE_MUTATIONS=false`
  - `ENABLE_WIDGETS=false` di fase awal
  - `ALLOW_DEV_PSK=false` di produksi
  - `REQUIRE_SESSION_ENCRYPTION=true`
  - `MCP_LEGACY_MODE=reject`
  - `MCP_SERVER_NAME`, `MCP_SERVER_VERSION`

Secrets (`wrangler secret put`, bukan vars): `OWNER_PASSWORD`, `SESSION_ENCRYPTION_KEY`. Opsional bootstrap token upstream. **Jangan** set `DEV_PSK` di produksi.

**Jangan** edit `vars` hanya di dashboard — deploy berikutnya menimpa.

## 2.3 `worker-configuration.d.ts`

Jaga sinkron dengan wrangler **dengan tangan**. `wrangler types` bisa menimpa runtime types yang bentrok dengan `@cloudflare/workers-types`. Secrets bertipe optional supaya Worker fail-closed, bukan crash saat boot.

Binding wajib: `LOADER`, `OAUTH_KV`, `MUTATION_APPROVALS`, `<PLATFORM>_SESSIONS`, plus `OAUTH_PROVIDER` yang diinjeksikan provider sebelum handler jalan.

## 2.4 `src/index.ts` — dua handler + provider

Salin struktur `src/index.ts` repo acuan.

### `mcpApiHandler`

1. Baca `ctx.props` → `principalFromProps`. Fail closed 401 JSON `{ code: "UNAUTHORIZED" }` jika rusak.
2. `createSessionProvider(env)` + `approvalsStubFor(ns, principal.subject)`.
3. `createMcpHandler(() => createXxxServer(...), { route: "/mcp", legacy, allowedHostnames: [public hostname, localhost, 127.0.0.1], onerror })`.
4. `authInfo`: `token: "redacted"`, `clientId`, `scopes`, `extra: { subject, via }`.

### `appHandler`

| Method + path | Perilaku |
| --- | --- |
| `GET /healthz` | `{ ok, name, version, protocol: "2026-07-28", mutations }` |
| `GET /` | `{ name, mcp: origin/mcp, authorization }` menunjuk `/.well-known/oauth-protected-resource/mcp` |
| `/authorize` | consent owner (override endpoint provider) |
| `/login` `/logout` | owner cookie |
| `/approvals/:uuid` | halaman mutasi |
| `/connect*` | sesi upstream |
| lainnya | 404 |

Provider (bukan `appHandler`) yang melayani token, DCR, dan well-known:

| Method | Path | RFC / peran |
| --- | --- | --- |
| `POST` | `/oauth/token` | code + refresh, PKCE S256 |
| `POST` | `/oauth/register` | DCR **RFC 7591** |
| `GET` | `/.well-known/oauth-protected-resource` | **RFC 9728** |
| `GET` | `/.well-known/oauth-protected-resource/mcp` | RFC 9728 path-appended (resource = `/mcp`) |
| `GET` | `/.well-known/oauth-authorization-server` | **RFC 8414** |

Klien publik: `tokenEndpointAuthMethod: "none"` — tukar token memakai verifier PKCE, bukan client secret.

### `OAuthProvider`

- `apiRoute: "/mcp"`, `authorizeEndpoint: "/authorize"`, `tokenEndpoint: "/oauth/token"`, `clientRegistrationEndpoint: "/oauth/register"`
- `clientIdMetadataDocumentEnabled: true` — URL `client_id` https di-fetch saat authorize (`global_fetch_strictly_public` blokir SSRF). Gagal → `CimdFetchError` HTML 400 lokal, jangan auto-redirect
- `scopesSupported` = read / write / admin
- TTL: access **3600 s**, refresh **180 hari**, DCR client **365 hari**
- `clientRegistrationCallback` menolak metadata terlalu besar: ≤ **5** redirect URI, tiap URI ≤ **512**, `client_name` ≤ **100**, JSON metadata ≤ **8192** byte
- `resourceMetadata.resource = ${PUBLIC_BASE_URL}/mcp`
- `resourceMetadata.scopes_supported` default **read saja** (write/admin hanya di consent)
- `bearer_methods_supported: ["header"]`
- `authorization_servers: [base]` hanya jika base https
- `tokenExchangeCallback` menyalin `props.scopes` dari scope yang **benar-benar di-issue**
- `resolveExternalToken` = DEV_PSK (lihat aturan di invariants)
- HTTP→HTTPS **308** kecuali localhost / 127.0.0.1
- Unhandled → JSON `{ code: "INTERNAL", message: "Internal error" }` tanpa stack
- Cache provider per `PUBLIC_BASE_URL` origin
- `createMcpHandler.allowedHostnames`: hostname `PUBLIC_BASE_URL` + `localhost` + `127.0.0.1`. Tes Node harus set header `Host` — `Request` tidak menurunkan Host dari URL

`PUBLIC_BASE_URL` wajib https kecuali hostname localhost/127.0.0.1. Kosong atau http di produksi → 503.

## 2.5 Owner auth

File: `src/auth/owner.ts`, `owner-routes.ts`, `pages.ts`, `verify.ts`, `scopes.ts`.

| Konstanta | Nilai |
| --- | --- |
| `OWNER_SUBJECT` | `"owner"` |
| Password min | **16** karakter |
| Cookie owner TTL | **8 jam** |
| Cookie CSRF TTL | **8 jam, sama dengan owner** |
| CSRF token | 32 hex (UUID tanpa `-`) |
| HMAC | HKDF-SHA-256 dari `SESSION_ENCRYPTION_KEY`, salt = SHA-256(`owner:${password}`), info = string unik proyek |
| Flag cookie https | `__Host-` + `Secure` + `HttpOnly` + `SameSite=Lax` + `Path=/`. Jangan set `Domain=` |
| Bandingkan password | SHA-256 lalu XOR (constant-time). Jangan `===` langsung |
| Rate limit password | **10 gagal / 15 menit / IP** (IPv6 dipotong `/64`). **Tanpa** bucket global |
| Instance DO rate | `idFromName("ratelimit:owner-password")` |
| `safeNext` | hanya `/connect`, `/connect/…`, `/approvals/<uuid>` |

Consent `/authorize`:

- Parse `AuthRequest`; `AuthorizationError` / `CimdFetchError` dirender lokal (400)
- Tampilkan nama klien yang diklaim sendiri, client id, origin `redirectUri`
- Scope: `read` selalu; `write` jika diminta **atau** `ENABLE_MUTATIONS=true`; `admin` hanya jika diminta
- Default centang: `read` saja
- Deny → redirect `access_denied`
- Approve tanpa satu scope pun → 400 “Select at least one scope.”
- Password di form yang sama jika cookie owner belum ada

`principalFromProps`: buang scope yang tidak dikenal. Props tanpa `subject` string atau `scopes` array → 401.

`admin` mengimplies semua. `write` mengimplies `read`. `requireScope` melempar `FORBIDDEN` + `Missing scope …`.

## 2.6 Vitest

- `environment: "node"`
- `include: ["tests/**/*.test.ts"]`
- `testTimeout: 30_000`
- `server.deps.inline`: `@cloudflare/codemode`, `@cloudflare/workers-oauth-provider`
- alias `@` → `src/`
- alias `cloudflare:workers` → `tests/stubs/cloudflare-workers.ts`

Loader palsu: `tests/stubs/fake-worker-loader.ts`. Jangan panggil Worker Loader sungguhan di unit test.

## 2.7 Cek fase 2

```
bun install
cp .dev.vars.example .dev.vars   # OWNER_PASSWORD, SESSION_ENCRYPTION_KEY, ALLOW_DEV_PSK=true, DEV_PSK
bun run dev
curl http://localhost:8787/healthz
curl -si -X POST http://localhost:8787/mcp | head   # 401 + WWW-Authenticate
```

Tes yang harus hijau (salin lalu ganti nama): `tests/security/auth.test.ts`, `tests/security/oauth-consent.test.ts`.
