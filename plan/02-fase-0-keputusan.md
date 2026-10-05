# Fase 0 — keputusan yang harus dikunci dulu

Jangan tulis kode sebelum jawaban ini tertulis di `docs/architecture/overview.md` proyek baru.

## 0.1 Karakter platform

Tulis satu paragraf per poin.

| Pertanyaan | Yang harus Anda tentukan |
| --- | --- |
| Ada API resmi + key? | Jika **ada**: skip Connect login, pakai key di secret Worker. Jika **tidak**: wajib capture + Connect |
| Auth upstream | Daftar `authProfile` yang benar-benar muncul di capture: `bearer`, `raw-token`, `cookie-csrf`, `www-csrf`, `none`. Jangan daftarkan yang tidak ada |
| Host | Allowlist **tertutup**. Jangan terima host dari input model |
| Tenant | Satu Worker = satu slug/id di config |
| Login | Alur yang Anda **mau dukung**. Tolak sisanya (OTP, SSO pihak ketiga, pilih merchant) dengan **410** + pesan jelas |
| Umur sesi | Ada refresh token resmi? Jika tidak: owner reconnect manual saat expire |
| Mutasi | Default OFF sampai ada approval UI + tes keamanan |
| Widget | Apakah host target (Claude.ai / ChatGPT) benar-benar merender MCP Apps? Bisa ditunda |
| Bahasa UI / teks tool | Bahasa yang dipakai operator |
| Zona waktu bisnis | Zona yang dipakai tanggal laporan |

## 0.2 Nama yang harus diganti sebelum scaffolding

Siapkan tabel pengganti **sebelum** copy file.

| Slot | Isi proyek baru |
| --- | --- |
| Nama paket / Worker | `<brand>-mcp` |
| Scope OAuth | `<platform>:read` / `write` / `admin` |
| URI resource | `<platform>://docs/…`, `://openapi`, `://capabilities`, `://coverage` |
| URI widget | `ui://<brand>/<view>.html` |
| Kelas dispatcher | `<Platform>Dispatcher` |
| DO sesi | `<Platform>SessionsDO` / binding `<PLATFORM>_SESSIONS` |
| Session provider | `Composite<Platform>SessionProvider` |
| Slug tenant | `TENANT_SLUG` / `SHOP_ID` / … |
| Cabang default | hapus jika platform tidak punya |
| Custom domain | `mcp.<domain-anda>` |
| Kode error | `<PLATFORM>_AUTH_EXPIRED` / `<PLATFORM>_RATE_LIMITED` |
| Secret bootstrap | nama yang sesuai token/cookie platform |
| Cookie owner / CSRF | prefix baru **dan** string HKDF info |
| HKDF salt sesi | string unik proyek |
| HKDF info sesi | string unik proyek |
| Marker widget | `__<BRAND>_VIEW__` |
| Resource name OAuth | nama produk baru |

Jangan sisakan nama produk lama, host lama, atau cookie lama di kode produksi, tes, README pemakai, atau OpenAPI.

## 0.3 Stack yang sudah terbukti (pin versi)

Salin versi dari `package.json` repo acuan. Range `^` hanya untuk wrangler / zod / vitest / typescript. Paket protokol **exact**.

| Komponen | Versi | Fungsi |
| --- | --- | --- |
| MCP protocol | `2026-07-28` | Streamable HTTP, `server/discover`. `GET /mcp` = 405 |
| `@modelcontextprotocol/server` | **2.0.0 exact** | SDK v2 `McpServer` |
| `@modelcontextprotocol/client` | **2.0.0 exact** (dev) | E2E saja |
| `agents` | 0.23.0 | `createMcpHandler` dari `agents/mcp/server`, **stateless** |
| `@cloudflare/workers-oauth-provider` | **0.10.3 exact** | AS + resource server, DCR, CIMD |
| `@cloudflare/codemode` | 0.5.2 | `DynamicWorkerExecutor` saja |
| `@modelcontextprotocol/ext-apps` | **2.0.0 exact (dev)** | Widget SPA saja. Worker **tidak** mengimpornya |
| wrangler | 4.131.2 | `worker_loaders`, custom domain |
| zod | 4.6.5 | Schema tool/prompt |
| React | **19.3.0 exact** | Widget SPA |
| TanStack Router / Query | 1.170.36 / 5.102.8 | Widget SPA |
| Vite | **8.3.0 exact** | Widget build |
| `vite-plugin-singlefile` | **2.3.3 exact** | Satu file HTML |
| playwright-core | **1.63.0 exact** | `widgets:smoke` |
| TypeScript | 7.0.2 | |
| vitest | 5.0.0 | |
| Workers | `compatibility_date: 2026-09-15` | flags: `nodejs_compat` + `global_fetch_strictly_public` |

**Larangan:** `McpAgent`, `createLegacyMcpHandler`, SDK MCP v1, `codeMcpServer()` / `openApiMcpServer()`, import `ext-apps` di Worker.

## 0.4 Kriteria keluar fase 0

- [ ] Tabel 0.1 tertulis di `docs/architecture/overview.md`
- [ ] Tabel 0.2 tertulis (termasuk HKDF label, cookie prefix, error code)
- [ ] Jalur A (API key resmi) atau jalur B (dashboard session) dipilih
- [ ] Mutasi dan widget diputuskan: sekarang / belakangan / tidak
