# Checklist pengerjaan

Cetak ini dan centang. Jangan loncat ke widget sebelum baris 6.6 hijau.

## Capture & desain

- [ ] 0.1 Tabel keputusan fase 0 tertulis di `docs/architecture/overview.md`
- [ ] 0.2 Tabel pengganti nama tertulis (termasuk HKDF label + cookie prefix + error code)
- [ ] 1.1 Login + ≥ 5 operasi read ter-capture, PII disamarkan
- [ ] 1.2 Setiap endpoint punya status evidence
- [ ] 1.3 Host allowlist final
- [ ] 1.4 Hop yang ditolak (OTP/SSO/…) tertulis, akan dijawab 410

## Scaffold

- [ ] 2.1 Repo + pin dependency (bukan range longgar pada MCP/OAuth/codemode/ext-apps)
- [ ] 2.2 `wrangler.jsonc` custom domain, KV, DO, loader, flags SSRF, `workers_dev: false`
- [ ] 2.3 Secrets lokal di `.dev.vars` (gitignored)
- [ ] 2.4 `/healthz` + `/mcp` 401 tanpa token + `WWW-Authenticate`; `GET /mcp` = 405
- [ ] 2.4b Well-known RFC 9728 (`/.well-known/oauth-protected-resource` + `/mcp`) dan RFC 8414 AS metadata merespons JSON
- [ ] 2.5 Consent owner password + CSRF 8 jam + rate limit per-IP tanpa bucket global; error CIMD 400 lokal
- [ ] 2.6 DCR RFC 7591: ≤5 URI, nama ≤100, JSON ≤8192; CIMD on; TTL access 3600 / refresh 180d / client 365d; klien publik `tokenEndpointAuthMethod: none`
- [ ] 2.7 Tes auth + oauth-consent hijau
- [ ] 2.8 HTTP→HTTPS 308 kecuali localhost; unhandled `{ code: "INTERNAL" }`

## Registry & dispatcher

- [ ] 3.1 `ApiOperation` untuk semua read yang akan di-expose; `additionalProperties: false`
- [ ] 3.2 `description` memuat jebakan capture (param yang 500 / tidak memfilter)
- [ ] 3.3 `validateOperationInput` + OpenAPI 3.1 tanpa example PII
- [ ] 3.4 Coverage: dokumen ↔ manifest 1:1, `coverage:validate` hijau
- [ ] 3.5 `docs:bundle` + sanitizer PII + tes drift
- [ ] 4.1 Session provider (static dan/atau DO + AES-GCM v2 + AAD + `REQUIRE_SESSION_ENCRYPTION=true`)
- [ ] 4.2 Connect **atau** paste key (owner-only). Pemilih-tenant / OTP / hop liar = **410** (bukan 404). Disconnect menyisakan `device_id`
- [ ] 4.3 Origin selalu dari config
- [ ] 5.1 Dispatcher + allowlist + redirect policy + status mapping
- [ ] 5.2 `preflight()` tanpa fetch
- [ ] 5.3 HTML adapter (jika ada) memakai `assertExpectedPage`, bukan empty-success
- [ ] 5.4 `fetch` di-bind tanpa `this` ke dispatcher

## MCP surface

- [ ] 6.1 `search` + `execute` + Code Mode budget terminal
- [ ] 6.2 `authInfo.token = "redacted"`
- [ ] 6.3 Resources docs/openapi/capabilities/coverage
- [ ] 6.4 Prompts kecil, tidak injeksi default cabang ke execute
- [ ] 6.5 Tes protocol + codemode security (fetch diblokir, key selundupan, write ditolak, error tanpa details)
- [ ] 6.6 `scripts/e2e-mcp.ts` lokal (OAuth + tools/list + search tanpa live)
- [ ] 6.7 E2E `--live` read-only setelah sesi terhubung; hasil bukan HTML login

## Widget (opsional)

- [ ] 7.1 `contract.ts` DOM-free + konstanta MCP Apps di-inline
- [ ] 7.2 View tools + helper; `_meta.structuredContent` diduplikasi; alias ChatGPT `openai/outputTemplate` + `widgetAccessible: true`
- [ ] 7.3 Tes keamanan per tool
- [ ] 7.4 SPA: `createMemoryHistory`, tanpa `fetch`/storage/cookie/form/`dangerouslySetInnerHTML`; tombol `type="button"`
- [ ] 7.5 Bundle committed + hash tes + smoke Chrome `connect-src 'none'`
- [ ] 7.6 `ENABLE_WIDGETS=false` mematikan seluruh permukaan

## Mutasi (opsional)

- [ ] 8.1 DO approvals + halaman owner CSRF
- [ ] 8.2 Empat gerbang + preflight-before-consume
- [ ] 8.3 Tes keamanan mutasi
- [ ] 8.4 Produksi tetap `ENABLE_MUTATIONS=false` sampai ada alasan bisnis

## Produksi

- [ ] 9.1 KV namespace, DO migration `v1` (jangan diedit setelah deploy), Worker Loader enabled
- [ ] 9.2 Custom domain di zone yang sama; bukan `workers.dev`
- [ ] 9.3 `wrangler secret put OWNER_PASSWORD` + `SESSION_ENCRYPTION_KEY`
- [ ] 9.4 `ALLOW_DEV_PSK=false`, tidak ada `DEV_PSK`
- [ ] 9.5 `bun run check-types && bun run test && bun run coverage:validate && bun run build`
- [ ] 9.6 Deploy, `/healthz`, e2e `--base https://mcp.<domain>`
- [ ] 9.7 Owner menjalankan Connect sekali
- [ ] 9.8 Connector di Claude Code / Cursor / VS Code
- [ ] 9.9 WAF tidak memblokir `160.79.104.0/21` jika Claude.ai dipakai
- [ ] 9.10 `security.md` memuat residual risk (data ke model, single-factor owner, rotasi password ≠ revoke OAuth)
- [ ] 9.11 README cukup untuk owner non-developer
