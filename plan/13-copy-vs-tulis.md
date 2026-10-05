# Peta copy vs tulis ulang

Pola dari repo acuan. Ganti identitas. **Tulis baru** = tergantung platform upstream Anda.

| Path acuan | Tindakan untuk platform baru |
| --- | --- |
| `src/index.ts` | Copy struktur, ganti nama server/resource/DO/resourceMetadata |
| `src/auth/owner.ts` | Copy; ganti cookie prefix + HKDF info |
| `src/auth/owner-routes.ts` | Copy; ganti binding DO rate-limit + copy halaman |
| `src/auth/pages.ts` `src/web/html.ts` | Copy kerangka; ganti brand, copywriting, bahasa |
| `src/auth/scopes.ts` `verify.ts` | Copy; ganti string scope |
| `src/errors/codes.ts` | Copy set; rename kode auth/rate-limit platform |
| `src/observability/log.ts` | Copy utuh |
| `src/observability/redact.ts` | Copy; **tambah** `SECRET_KEYS` + pola cookie/PII platform; tulis ulang `PERSON_FIELDS` |
| `src/mcp/server.ts` | Copy struktur; ganti deskripsi tool, nama dispatcher |
| `src/mcp/results.ts` | Copy utuh |
| `src/mcp/resources.ts` | Copy; ganti URI scheme + payload capabilities |
| `src/mcp/prompts.ts` | **Tulis** skenario bisnis baru |
| `src/mcp/mutation-tool.ts` | Copy utuh (ganti tidak perlu kecuali pesan) |
| `src/codemode/*` | **Copy utuh** (platform-agnostik) |
| `src/dispatcher/path.ts` | Copy utuh |
| `src/dispatcher/upstream.ts` | Copy; ganti deteksi URL login |
| `src/dispatcher/allowlist.ts` | **Tulis ulang** host + slug + `isLoginUrl` |
| `src/dispatcher/*-dispatcher.ts` | Copy alur; ganti `buildHeaders` / adapter HTML / nama log |
| `src/registry/types.ts` | Copy; ganti `HostKey` (dan `AuthProfile` jika perlu) |
| `src/registry/validate.ts` | Copy utuh |
| `src/registry/ops/helpers.ts` | Copy; sesuaikan `dateRange` jika nama field beda |
| `src/registry/ops/*.ts` | **Tulis baru** dari dokumen capture |
| `src/registry/operations.ts` | Copy aggregator |
| `src/registry/exclusions.ts` | **Tulis baru** |
| `src/registry/doc-endpoints.ts` | **Tulis ulang** parser + `API_DOC_NAMES` |
| `src/registry/coverage.ts` `checks.ts` | Copy; ganti `HTML_ADAPTERS` + path dispatcher + regex kredensial |
| `src/registry/openapi.ts` | Copy mesin; ganti `HOST_URLS` + `info.title` + vendor key |
| `src/session/crypto.ts` | Copy algoritma; **ganti** HKDF salt/info |
| `src/session/session-store.ts` | Copy; ganti nama field spesifik |
| `src/session/*-session.ts` `*-sessions-do.ts` | Sesuaikan origin/secret names/class name |
| `src/connect/gate.ts` | Copy |
| `src/connect/cookie-jar.ts` | Copy; ganti domain allowlist |
| `src/connect/redirect-allowlist.ts` | **Tulis ulang** host |
| `src/connect/login-flow.ts` `login-continue.ts` `login-parse.ts` | **Tulis ulang** mengikuti `docs/auth-login.md` baru |
| `src/connect/extract-token.ts` `paste.ts` | **Tulis ulang** bentuk token |
| `src/connect/routes.ts` | Copy tabel rute; ganti hop 410 + rate limit |
| `src/connect/html.ts` | Copy kerangka; ganti copy |
| `src/html/*` | **Tulis baru** dari fixture, atau hapus |
| `src/widgets/contract.ts` | Copy kerangka konstanta; **tulis** view/tool/schema/label |
| `src/widgets/tools/define.ts` `budget.ts` | Copy utuh |
| `src/widgets/tools/*.ts` (proyeksi) | **Tulis baru** |
| `src/widgets/resources.ts` `bundled.ts` | Copy; ganti URI/marker; bundle ulang |
| `widgets/` | Copy kerangka (vite, bridge, smoke); **tulis** route/view |
| `src/approvals/*` | **Copy utuh** (platform-agnostik) |
| `scripts/bundle-docs.ts` `bundle-widgets.ts` `validate-*.ts` | Copy |
| `scripts/e2e-mcp.ts` | Copy; ganti URL, nama tool cek, env connect; jangan panggil mutasi |
| `tests/stubs/*` | Copy; ganti nama tipe |
| `tests/security/*` | Copy **kasus**; ganti operationId + scope + error code |
| `tests/protocol/*` `tests/unit/*` `tests/evals/*` | Copy bentuk; ganti fixture |
| `docs/*.md` (API) | **Tulis baru** dari capture |
| `docs/architecture/*` | Tulis baru, ikuti kerangka |
| `wrangler.jsonc` | Copy bentuk; **jangan** copy `account_id`, KV id, domain, slug, secret |
| `worker-configuration.d.ts` | Copy bentuk; ganti binding/secret names |
| `.dev.vars.example` | Copy; ganti nama secret |

## Yang paling sering salah

1. Menyalin host allowlist tanpa menulis ulang.
2. Menyalin hop login (PIN, OTP, token scrape) ke platform yang beda.
3. Menyalin `ops/*.ts` lalu “rename”. Operasi harus dari capture.
4. Menyalin `account_id` / KV id / domain.
5. Tidak mengganti HKDF salt/info — blob sesi proyek lain bisa kebaca jika key sama.
