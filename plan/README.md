# Plan: remote MCP Worker untuk satu tenant

Folder ini adalah **blueprint** untuk membangun MCP remote di Cloudflare Workers yang arsitekturnya sama dengan kode di repo ini. Isinya dua hal:

1. **Cara kerja** — mesin yang sudah jalan: OAuth, dua tool umum (`search` / `execute`), sandbox, dispatcher, sesi upstream, widget, mutasi.
2. **Cara membangun ulang** — fase 0–9, checklist, peta copy-vs-tulis, kartu konstanta.

Bukan fork search-replace. Bukan satu tool MCP per REST endpoint. Bukan API key yang dilempar ke model.

## Siapa yang pakai folder ini

Anda punya platform upstream (dashboard POS, ERP, admin panel, API internal) dan ingin asisten AI membaca datanya lewat URL MCP + sign-in browser.

Satu Worker = **satu tenant**. Pemanggil tidak pernah memilih origin.

## Urutan baca

| # | File | Isi |
| --- | --- | --- |
| 1 | [00-cara-kerja.md](00-cara-kerja.md) | Runtime: request flow, tiga jalur eksekusi, state |
| 2 | [01-invariants.md](01-invariants.md) | Aturan keamanan yang tidak boleh “disederhanakan” |
| 3 | [02-fase-0-keputusan.md](02-fase-0-keputusan.md) | Keputusan yang dikunci sebelum kode |
| 4 | [03-fase-1-capture.md](03-fase-1-capture.md) | Capture API upstream (sebelum registry) |
| 5 | [04-fase-2-scaffold.md](04-fase-2-scaffold.md) | Worker + OAuth 2.1 + owner password |
| 6 | [05-fase-3-registry.md](05-fase-3-registry.md) | Catalog operasi, validasi, OpenAPI, coverage |
| 7 | [06-fase-4-sesi.md](06-fase-4-sesi.md) | Sesi terenkripsi + Connect |
| 8 | [07-fase-5-dispatcher.md](07-fase-5-dispatcher.md) | Satu-satunya `fetch` ke upstream |
| 9 | [08-fase-6-mcp.md](08-fase-6-mcp.md) | `search` + `execute` + Code Mode |
| 10 | [09-fase-7-widgets.md](09-fase-7-widgets.md) | MCP Apps (opsional) |
| 11 | [10-fase-8-mutasi.md](10-fase-8-mutasi.md) | `execute_mutation` (opsional, default OFF) |
| 12 | [11-fase-9-produksi.md](11-fase-9-produksi.md) | Log, PII, README owner, deploy |
| 13 | [12-checklist.md](12-checklist.md) | Urutan pengerjaan yang bisa dicentang |
| 14 | [13-copy-vs-tulis.md](13-copy-vs-tulis.md) | File mana yang disalin, mana yang ditulis ulang |
| 15 | [14-anti-pola.md](14-anti-pola.md) | Yang terlihat lebih cepat tapi merusak |
| 16 | [15-konstanta.md](15-konstanta.md) | Angka yang sudah terbukti di kode |

Jangan loncat ke widget sebelum read path hijau (checklist 6.6). Jangan hidupkan mutasi sebelum empat gerbang + tes keamanan hijau.

## Yang ditiru (pola), bukan yang ditiru (identitas)

**Pola:** Cloudflare Worker, OAuth 2.1 (DCR RFC 7591 + PKCE S256 + CIMD + RFC 9728/8414 well-known), MCP protocol `2026-07-28`, Code Mode isolate `globalOutbound: null`, registry operasi, dispatcher allowlist, sesi AES-GCM, coverage 1:1 dengan dokumen.

**Bukan pola yang disalin:** nama produk, domain, slug tenant, `account_id` Cloudflare, id KV, string scope, cookie prefix, label HKDF, kode error platform, hop login, host allowlist, operasi bisnis.

## Definisi “selesai” untuk read path

1. `check-types`, `test`, `coverage:validate` hijau.
2. E2E OAuth + `tools/list` berisi `search` dan `execute` (tanpa `execute_mutation` jika flag off).
3. `search` mengembalikan catalog yang cocok dengan dokumen capture.
4. `execute` read hidup mengembalikan data nyata, bukan HTML login.
5. Tanpa token → 401. Tanpa scope → `FORBIDDEN`. Tanpa sesi → `<PLATFORM>_AUTH_EXPIRED` + instruksi `/connect`.
6. Sandbox tidak bisa `fetch`, tidak bisa write, tidak bisa menambah `method` / `url` / `headers` / host.
7. Log tidak berisi token, PIN, password, username mentah.
8. README cukup untuk owner non-developer menghubungkan klien MCP.
9. Setiap `METHOD + host + path` di docs muncul tepat sekali di coverage manifest.
10. Resource `capabilities` mencerminkan tool yang benar-benar terdaftar untuk token itu.

Widget dan mutasi adalah fase terpisah.
