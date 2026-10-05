# Cara kerja

Satu Cloudflare Worker melayani **satu tenant**. Ia mengekspos remote MCP di `https://mcp.<domain>/mcp`. Asisten AI (Claude, Cursor, Codex, ChatGPT, …) menghubungkan URL itu, owner menyetujui di browser dengan password owner, lalu model membaca data live dari platform upstream.

Tidak ada program yang diinstal di komputer pemakai. Tidak ada API key yang diketik ke klien. Kredensial upstream tidak pernah masuk ke model, log, OpenAPI, atau HTML widget.

## Gambar besar

```
Klien MCP (Claude / Cursor / Codex / ChatGPT)
        │
        │  Authorization: Bearer <access token>
        │  audience = ${PUBLIC_BASE_URL}/mcp
        ▼
┌──────────────────────────────────────────────────────────────┐
│  Cloudflare Worker                                           │
│                                                              │
│  OAuthProvider                                               │
│    apiRoute /mcp  ──► mcpApiHandler                          │
│                       principal dari ctx.props (fail closed) │
│                       createMcpHandler (stateless, per req)  │
│                         ├── search    ─┐                     │
│                         ├── execute   ─┼► Code Mode isolate  │
│                         │              │  globalOutbound:null│
│                         │              └── dispatcher.fetch  │
│                         ├── execute_mutation  (flag + scope) │
│                         ├── widget tools      (host, bukan   │
│                         │                      sandbox)      │
│                         └── resources + prompts              │
│                                                              │
│    defaultHandler ──► appHandler                             │
│                         GET  /healthz  /                     │
│                         /authorize  /login  /logout          │
│                         /connect*                            │
│                         /approvals/:uuid                     │
└──────────────────────────────────────────────────────────────┘
        │
        │  KV          OAUTH_KV          (client, grant, token ter-hash)
        │  DO SQLite   <PLATFORM>_SESSIONS
        │  DO SQLite   MUTATION_APPROVALS
        │  Loader      LOADER            (isolate Code Mode, tanpa state)
        ▼
Platform upstream (hanya host di allowlist, https, port 443)
```

## Kenapa dua tool, bukan satu tool per endpoint

`tools/list` harus kecil dan stabil. Catalog puluhan operasi tidak boleh meledakkan daftar tool.

Model menulis **JavaScript** (async arrow function, 1–20_000 karakter):

- `search` — tanpa jaringan. `codemode.spec()` mengembalikan `{ catalog, openapi, examples }`.
- `execute` — `codemode.request({ operationId, path, query, body })` memanggil **satu operasi read terdaftar**. Host yang memilih method, host, path template, header, Origin/Referer, dan kredensial.

Agregasi (jumlah, filter, gabungan beberapa halaman) terjadi di dalam sandbox. Yang kembali ke model adalah ringkasan terpotong (~24 KB), bukan dump katalog.

## Alur satu panggilan `execute`

1. Klien `POST /mcp` + Bearer. `GET /mcp` = **405**. Tidak ada session id MCP.
2. Provider memverifikasi token ter-hash di KV **dan** audience `${PUBLIC_BASE_URL}/mcp`. Token rusak / hilang → 401 + `WWW-Authenticate` dengan `resource_metadata`.
3. `mcpApiHandler` membangun principal dari `ctx.props` (`subject`, scopes yang dikenal, `clientId`). Props rusak → 401 JSON `{ code: "UNAUTHORIZED" }`. Access token asli **tidak** diteruskan: `authInfo.token = "redacted"`.
4. Factory membuat `McpServer` **baru per request**. Capabilities `listChanged: false` untuk tools/resources/prompts. Tidak ada notifikasi.
5. Model mengirim JS. Isolate Worker Loader baru: `globalOutbound: null`, tanpa binding, tanpa secret, CPU 10 s.
6. JS memanggil `codemode.request({ operationId, query })`. Key lain (`method`, `url`, `headers`, `authorization`, `cookie`, `host`, …) ditolak **sebelum** dispatch.
7. Host: budget → registry (`exposed` + `safety: read`) → validasi input → sesi → resolve host dari operasi (bukan dari input) → allowlist → `fetch` `redirect: "manual"`.
8. JSON (atau HTML yang sudah di-parse adapter) kembali ke isolate. JS mengagregasi. Host memotong hasil secara struktural lalu hard-cap.

## Tiga jalur eksekusi

Semua jaringan upstream lewat **dispatcher yang sama**. Yang berbeda: siapa yang orkestrasi, operasi mana yang boleh, output apa.

| | `search` / `execute` | Widget `show_*` + helper | `execute_mutation` |
| --- | --- | --- | --- |
| Siapa orkestrasi | Model (JS di sandbox) | Anda (TypeScript di host) | Model pilih `operationId`; host yang jalan |
| Operasi | Catalog read yang `exposed` | Hardcoded per tool, read saja | Write / destructive terdaftar |
| Output | Satu blok teks JSON kecil | Teks + `structuredContent` + UI | Teks `{ executionId, operationId, status, data }` |
| Jaringan dari model | Tidak | Tidak | Tidak |
| Approval owner | Tidak | Tidak | Wajib, di browser |
| Cocok untuk | Ad-hoc, gabungan, “berapa total minggu lalu” | Dashboard tetap | Ubah data sekali |

Widget **tidak** jalan di sandbox. Host memanggil operasi yang sudah dikunci di definisi tool. Iframe widget sendiri **tidak** `fetch` (`connect-src 'none'`).

Mutasi **bukan** Code Mode. Input terstruktur (`operationId`, `path`, `query`, `body`, `approvalId`). Tanpa `approvalId` → `APPROVAL_REQUIRED` + URL halaman owner. Klien MCP tidak bisa menyetujui.

## OAuth: kenapa password owner, bukan API key klien

Remote MCP di klien cloud membutuhkan **browser sign-in**. Dynamic Client Registration membuat klien mendaftar sendiri (tanpa client id yang Anda terbitkan). Tanpa faktor yang Anda kontrol, siapa pun yang tahu URL bisa DCR + authorize.

Password owner (≥ 16 karakter, secret Worker) adalah faktor itu. Consent `/authorize` menampilkan:

- nama klien **yang diklaim sendiri**
- client id
- **origin** `redirect_uri`

Owner hanya menyetujui alur yang **baru ia mulai**. Deny = `access_denied`. Error parse (CIMD gagal, metadata rusak) dirender **lokal** (400) — jangan auto-redirect ke `redirect_uri` klien DCR (open redirector).

Scope:

- `<platform>:read` — selalu ditawarkan, default tercentang
- `<platform>:write` — jika diminta atau mutasi dihidupkan
- `<platform>:admin` — hanya jika diminta; mengimplies semua
- `write` mengimplies `read`

TTL: access **3600 s**, refresh **180 hari**, klien DCR **365 hari**. PKCE S256. Refresh rotation. Klien publik: `tokenEndpointAuthMethod: "none"` (verifier PKCE, bukan client secret). CIMD fetch di bawah `global_fetch_strictly_public` (blokir alamat privat). Gagal fetch CIMD → `CimdFetchError` HTML 400 lokal, **jangan** auto-redirect.

`resourceMetadata.scopes_supported` hanya **read**. Write/admin muncul di halaman consent, tidak diiklankan di metadata resource.

`DEV_PSK` hanya untuk skrip lokal: flag `ALLOW_DEV_PSK=true` **dan** host loopback **dan** kunci ≥ 16. Grant read+write, **bukan** admin. Produksi: flag `false`, secret tidak ada.

## Rute OAuth (provider, bukan `appHandler`)

Provider mencegat `/mcp` dulu: Bearer hilang/rusak → **401** + `WWW-Authenticate` menunjuk resource metadata. Token valid (audience = `${origin}/mcp`) menempelkan `ctx.props`, lalu `mcpApiHandler`.

| Method | Path | Peran |
| --- | --- | --- |
| `GET`/`POST` | `/authorize` | **Override** ke `appHandler` (consent owner). Provider tetap injeksi helper |
| `POST` | `/oauth/token` | Authorization code + refresh. PKCE S256 |
| `POST` | `/oauth/register` | Dynamic Client Registration (**RFC 7591**) |
| `GET` | `/.well-known/oauth-protected-resource` | **RFC 9728** |
| `GET` | `/.well-known/oauth-protected-resource/mcp` | RFC 9728 path-appended (resource = `/mcp`). JSON root menunjuk ke sini |
| `GET` | `/.well-known/oauth-authorization-server` | **RFC 8414** (default provider) |

## Rute browser (`appHandler`)

| Rute | Siapa | Apa |
| --- | --- | --- |
| `GET /healthz` | siapa saja | `{ ok, name, version, protocol, mutations }` |
| `GET /` | siapa saja | `{ name, mcp, authorization }` — `authorization` menunjuk `/.well-known/oauth-protected-resource/mcp` |
| `/authorize` | owner, dipicu klien MCP | Consent + password (atau cookie 8 jam) + CSRF |
| `/login` `/logout` | owner | Cookie HMAC. `next` hanya path relatif same-origin |
| `/connect*` | cookie owner (atau `x-dev-psk` di loopback) | Hubungkan / putuskan sesi. Hop tidak didukung = **410**, bukan 404 |
| `/approvals/:uuid` | cookie owner | Setujui / tolak mutasi sekali pakai |

HTML owner: `no-store`, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, HSTS 1 tahun, CSP `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'`. **Jangan** set `form-action` — redirect OAuth ke klien harus jalan.

## State

| Store | Binding | Isi |
| --- | --- | --- |
| Workers KV | `OAUTH_KV` | Klien DCR, grant `grant:owner:*`, access/refresh ter-hash `token:owner:*` |
| Durable Object SQLite | `<PLATFORM>_SESSIONS` | Instance `merchant:<SLUG>`: sesi terenkripsi, pending login (10 menit, **tanpa** PIN), device id stabil, bucket rate-limit ter-hash. Instance `ratelimit:owner-password`: percobaan password |
| Durable Object SQLite | `MUTATION_APPROVALS` | Instance per subject: approval sekali pakai, alarm GC 1 jam setelah expiry |
| Worker Loader | `LOADER` | Isolate Code Mode. Tanpa state, tanpa jaringan |

Sesi upstream: AES-256-GCM, kunci HKDF dari `SESSION_ENCRYPTION_KEY`, AAD mengikat storage key + kind + expiry. `REQUIRE_SESSION_ENCRYPTION=true` menolak plaintext. Record yang gagal didekripsi dihapus, bukan dikembalikan.

Origin tenant **selalu** dari config Worker (`MERCHANT_SLUG` / `TENANT_SLUG`), tidak dari body login, HTML, atau input model.

## Sesi upstream: dua jalur

```
Ada API key resmi?
  ya  → Static session provider + secret Worker
        (Connect opsional: paste key, owner-only)
  tidak → Capture hop login
          Implementasikan hop yang didukung
          410 untuk hop yang tidak didukung (OTP, SSO, pilih merchant, …)
          Paste fallback jika scrape token gagal
          Jangan mengarang URL mint-token
```

Composite provider: coba DO dulu; jika kosong, fallback secret bootstrap. `markExpired(failedToken?)` adalah **compare-and-delete**: sesi baru yang disimpan *selama* request gagal tetap hidup.

## Dispatcher

Satu kelas. Satu-satunya tempat tool memanggil `fetch` ke upstream. Bind `fetch` sebagai `(input, init) => fetch(input, init)` — jangan simpan `globalThis.fetch` sebagai method (workerd: “Illegal invocation”).

Limit per request: 25 s wall-clock, 2 MB body (stream, jangan `text()` dulu), max 3 redirect GET same-host.

Status:

| Upstream | Error ke model | Sesi |
| --- | --- | --- |
| 401, redirect login, HTML login padahal JSON diharapkan | `<PLATFORM>_AUTH_EXPIRED` | hapus hanya jika profile Bearer/raw-token **dan** token masih sama |
| 419 / CSRF page expired | `<PLATFORM>_AUTH_EXPIRED` | **tetap** (Bearer mungkin masih hidup) |
| 403 | `FORBIDDEN` | tetap |
| 429 | `<PLATFORM>_RATE_LIMITED` | tetap |
| 4xx/5xx JSON | `UPSTREAM_ERROR` (status saja, tanpa body) | tetap |

Non-GET + 3xx **tidak** diikuti: tulis mungkin sudah terjadi, jangan retry buta.

## Error ke model

Hanya `{ code, message }`. Tidak ada stack, `details`, cookie, token, PIN. Log tool error **hanya** kode, bukan message (message bisa dikontrol model).

Throw di sandbox / gagal compile → `INVALID_INPUT`. String palsu di message model (`"AUTH_EXPIRED: fake"`) **tidak** dipercaya sebagai kode host.

## Protocol

- MCP `2026-07-28` (Streamable HTTP). `server/discover` hanya mengiklankan `["2026-07-28"]` + capabilities tools/resources/prompts (`listChanged: false`).
- Header `MCP-Protocol-Version` + `_meta["io.modelcontextprotocol/protocolVersion"]`.
- Versi tidak didukung → JSON-RPC **`-32022`**, HTTP 400, jika `MCP_LEGACY_MODE=reject`.
- `GET /mcp` = **405**. Tidak ada session id MCP / SSE.
- `createMcpHandler` butuh `allowedHostnames` (hostname publik + `localhost` + `127.0.0.1`). Objek `Request` Node **tidak** menurunkan `Host` dari URL — tes harus set header `host`.
- Server SDK v2 `McpServer` via `createMcpHandler` dari `agents/mcp/server`, **stateless**.
- **Tidak dipakai:** `McpAgent`, `createLegacyMcpHandler`, SDK v1, `codeMcpServer()` / `openApiMcpServer()` dari `@cloudflare/codemode` (mereka membangun server v1).
- Worker **tidak** mengimpor `@modelcontextprotocol/ext-apps`. Konstanta MCP Apps di-inline di kontrak widget.

`legacy: "stateless"` hanya jika klien 2025-era gagal dengan `-32022`.

Urutan pabrik per request:

1. Selalu `search` + `execute`.
2. `execute_mutation` hanya jika `ENABLE_MUTATIONS==="true"` **dan** stub approval terikat **dan** principal punya write/admin.
3. Widget tools + `ui://` kecuali `ENABLE_WIDGETS==="false"` (default **hidup**). Didaftarkan untuk setiap pemanggil; kapabilitas UI klien baru diketahui setelah factory.

## Widget (opsional)

Enam view bisnis (contoh POS: penjualan, produk, stok, pembelian, transaksi, piutang) + helper paging/detail. Satu SPA React di-bundle jadi **satu file HTML**, disajikan sebagai resource `ui://<brand>/<view>.html` (`text/html;profile=mcp-app`).

Host yang mendukung MCP Apps merender iframe sandbox. Data pertama datang dari hasil tool (seed cache). Interaksi berikutnya: `tools/call` lewat host, bukan jaringan iframe.

Klien tanpa renderer tetap mendapat **teks** yang menjawab pertanyaan. Default **hidup** (`ENABLE_WIDGETS !== "false"`). `ENABLE_WIDGETS=false` menghapus seluruh permukaan (tools + `ui://`).

ChatGPT butuh alias di `_meta` view tool: `ui/resourceUri`, `openai/outputTemplate`, `openai/widgetAccessible: true`. Helper: `openai/visibility=private` + `widgetAccessible: true`. Payload `structuredContent` **diduplikasi** di `_meta.structuredContent` karena jalur `callTool` ChatGPT kadang membuang field resmi.

Visibility helper (`ui.visibility: ["app"]`) **kosmetik**. Pemegang token read tetap bisa memanggil helper. Anggap seaman `execute`.

## Mutasi (opsional, default OFF)

Empat gerbang, semua wajib:

1. `ENABLE_MUTATIONS=true`
2. Token punya `write` atau `admin`
3. Operasi terdaftar `safety: write | destructive` — **efek**, bukan HTTP verb (GET yang membatalkan order = destructive)
4. Approval DO: subject + `operationId` + SHA-256 argumen ternormalisasi, TTL 10 menit, sekali pakai

Urutan eksekusi: **`preflight` (tanpa fetch) → `consume` → `dispatch({ allowMutation: true })`**. Gagal lokal tidak boleh menghabiskan approval.

## Yang model tidak pernah lihat

- Password owner, PIN / password platform
- Access token OAuth (redacted)
- Cookie jar, CSRF, API token
- `SESSION_ENCRYPTION_KEY`
- Stack trace, `details` AppError
- Host / URL / method mentah untuk “dipilih”

Yang model **lihat** (by design remote MCP): data bisnis live — nama pelanggan, angka penjualan, stok. Grant hanya ke klien yang Anda percayai dengan data itu.
