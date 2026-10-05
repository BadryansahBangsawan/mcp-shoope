# Fase 9 — observasi, PII, dokumentasi pemakai, deploy

## 9.1 Log

`log(level, message, fields)` → satu baris JSON ke Workers Logs. Semua `fields` lewat `redactValue`.

`SECRET_KEYS` (regex, case-insensitive) — salin dan **tambah** nama header/cookie platform Anda:

```
authorization, cookie, x-csrf-token, xsrf-token, password, pin,
token, api_token, api-token, tokenweb, <cookie-sesi-platform>,
<nama-session-cookie>, bearer
```

`TOKENISH`: `Bearer …`, hex 32, tokenish ≥ 40 karakter → `[REDACTED]`.

Jangan log username/PIN. `usernameLen` boleh. Token prefix 4 karakter boleh di status connect.

## 9.2 PII di docs

`sanitizeDocMarkdown` saat baca resource:

- field orang (sesuaikan daftar: nama, telepon, email, alamat, id_number, created_by_name, …)
- UUID → `<UUID>`
- telepon lokal / internasional → `<PHONE_REDACTED>`
- email → `<EMAIL_REDACTED>`
- `Bearer …` → `Bearer <TOKEN>`
- cookie sesi / CSRF di contoh → placeholder

Tes `docs-pii.test.ts` wajib gagal jika sample asli kembali.

## 9.3 Dokumentasi pemakai (bukan developer)

README harus cukup untuk owner yang bukan developer:

- URL MCP `https://mcp.<domain>/mcp`
- Cara owner buka `/connect` (password owner **bukan** PIN/password platform)
- Cara add connector:
  - Claude Code: `claude mcp add --transport http <name> https://mcp.<domain>/mcp`
  - Cursor / VS Code / Codex: lihat `docs/install-prompts.md`
- Centang **hanya** `<platform>:read` kecuali mutasi memang dihidupkan
- Apa yang terjadi saat sesi expire (buka `/connect` lagi)
- Widget muncul di klien yang mendukung MCP Apps; klien lain tetap dapat teks

Tulis juga `docs/architecture/{overview,security,setup,operations,coverage}.md`.

## 9.4 Residual risk (wajib di `security.md`)

- Data hidup (nama pelanggan, angka penjualan, stok) **sampai ke model provider**. Ini by design remote MCP.
- Password owner = single factor. Tidak ada 2FA di Worker.
- Rotasi `OWNER_PASSWORD` mematikan cookie owner, **tidak** mencabut token OAuth. Cabut grant di KV (`grant:owner:*` / `token:owner:*`) secara terpisah.
- Consent phishing: owner hanya approve flow yang **baru ia mulai**; cek redirect origin di halaman consent.
- Satu sesi upstream dipakai semua klien OAuth yang sudah di-grant.
- API tidak resmi bisa berubah tanpa kabar. Coverage + tes e2e `--live` adalah detektor, bukan jaminan.
- Visibility helper widget bukan batas keamanan.
- `DEV_PSK` di produksi yang `ALLOW_DEV_PSK=true` = bypass OAuth di loopback saja; tetap jangan hidupkan flag itu di wrangler produksi.

## 9.5 Deploy

1. Buat KV `OAUTH_KV`, enable Worker Loader di akun, custom domain di zone yang sama.
2. `wrangler secret put OWNER_PASSWORD`
3. `wrangler secret put SESSION_ENCRYPTION_KEY` (`openssl rand -base64 32`)
4. Opsional bootstrap secret upstream.
5. `ALLOW_DEV_PSK=false`, tidak ada `DEV_PSK`.
6. `bun run check-types && bun run test && bun run coverage:validate && bun run build`
7. `bunx wrangler deploy`
8. `GET https://mcp.<domain>/healthz`
9. `bun run e2e -- --base https://mcp.<domain>`
10. Owner menjalankan Connect sekali.
11. Tambah connector di klien.
12. WAF / Bot Fight Mode **tidak** memblokir IP Anthropic `160.79.104.0/21` jika Claude.ai dipakai.

## 9.6 Perintah harian

```bash
bun install
bun run check-types
bun run test                 # bukan `bun test` — script memicu vitest run
bun run coverage:validate
bun run openapi:validate
bun run docs:bundle          # setelah edit docs/*.md
bun run coverage:report
bun run widgets:bundle       # setelah edit widgets/ atau contract.ts
bun run widgets:test
bun run widgets:smoke
bun run e2e                  # Worker lokal
bun run build                # wrangler deploy --dry-run --outdir=dist
bunx wrangler deploy
```

Lokal:

```
cp .dev.vars.example .dev.vars
# isi OWNER_PASSWORD (>=16), SESSION_ENCRYPTION_KEY (openssl rand -base64 32),
# ALLOW_DEV_PSK=true, DEV_PSK (>=16)
bun run dev                  # http://localhost:8787
```
