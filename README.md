# shopee-mcp

Remote Cloudflare Worker MCP untuk **satu akun buyer Shopee** (XHR `https://shopee.co.id`). Bukan toko seller, bukan Open Platform.

**URL konektor:** `https://mcp.shopee.badry.engineer/mcp`

Tambahkan URL itu sebagai custom MCP connector (OAuth). Jangan buka `/mcp` di browser untuk “cek apakah hidup” — GET tanpa Bearer adalah **401** (RFC 6750). Itu gerbang OAuth, bukan DNS rusak. Health: `GET /healthz`.

## Apa ini

Dua tool: `search` (katalog API) dan `execute` (data hidup akun). Model tidak memilih URL, header, atau kredensial. Cookie + CSRF diinjeksikan Worker.

Katalog v1 (**12** operasi baca, evidence `observed`):

`account.profile` · `orders.list` · `orders.detail` · `orders.count` · `cart.get` · `address.list` · `voucher.list` · `voucher.meta` · `notifications.list` · `notifications.activities` · `wallet.overview` · `wallet.transactions`

Bukan:

- Seller Centre / Open Platform HMAC
- checkout, bayar, follow, autobuy, ubah keranjang
- scrape toko orang lain
- chat (host `seller.shopee.co.id` tidak di-allowlist)
- mutasi (`ENABLE_MUTATIONS=false`)

## Owner: Connect di produksi

Deploy **tidak** menyalin cookie dari laptop. Durable Object produksi kosong sampai operator Connect. Cloudflare Worker **tidak** menjalankan Chrome — login Shopee di mesin ini.

1. Set secret `OWNER_PASSWORD` (≥12) dan `SESSION_ENCRYPTION_KEY`.
2. `bunx playwright install chromium` (sekali).
3. `bun run auth` — Chrome for Testing membuka halaman QR Shopee. Scan di aplikasi Shopee (Scan QR/Barcode → Konfirmasi Log in). Skrip menyimpan `.runtime/auth/paste-tokens.json` (gitignored) dan POST ke Worker. Jangan ketik akun Shopee di Worker; jangan tempel cookie.
4. Cek `GET /connect/status` → `connected: true`. Saat klien minta consent, centang hanya `shopee:read`.

Lokal: `SHOPEE_MCP_BASE=http://127.0.0.1:8787 bun run auth`. Tanpa kirim otomatis: `SHOPEE_AUTH_SKIP_PASTE=1`.

Sidecar wajib mengirim cookie `SPC_EC` atau `SPC_ST` ke `shopee.co.id`. Cookie `www.shopee.co.id` di-rewrite ke apex. Domain pihak ketiga / seller / partner di-drop.

Tanpa sesi: `execute` gagal `SHOPEE_AUTH_EXPIRED`.

## Klien MCP

1. Resource: `https://mcp.shopee.badry.engineer/mcp`
2. OAuth 2.1 + PKCE. Scope yang diiklankan: `shopee:read`.
3. Claude.ai: custom connector ke URL di atas. Jika Authorize terblokir WAF, izinkan `160.79.104.0/21`.

Dua password: password **owner** (Worker) vs password **Shopee**. Klien MCP tidak pernah melihat password/OTP/cookie Shopee.

## Risiko (baca sebelum pakai)

- **ToS.** Ini XHR web tidak resmi. Melanggar ketentuan Shopee (bot/emulator). Hanya akun milik operator, read-only, bukan mass scrape.
- **PII.** Profil, alamat, telepon, isi pesanan ada di JSON upstream. Tool tidak menyensor field. Jangan dump ke log/chat publik.
- **Anti-bot.** Login dari IP Worker sering `needs_paste`. Cookie browser rumah bisa tetap 403 saat di-replay dari Cloudflare.
- **Sesi.** Cookie jar = akses akun. Jangan bagikan paste JSON.

Repo privat operator. Tidak ada LICENSE publik.

## Lokal

```
bun install
cp .dev.vars.example .dev.vars
bunx playwright install chromium
bun run check-types && bun run test && bun run coverage:validate && bun run openapi:validate
bun run dev
curl http://localhost:8787/healthz
SHOPEE_MCP_BASE=http://127.0.0.1:8787 bun run auth
```

Tes: `bun run e2e -- --base http://localhost:8787` (butuh owner password). `--connect` paste dari `SHOPEE_E2E_PASTE` atau `.runtime/auth/paste-tokens.json`. `--live` memanggil read akun.

Jangan commit HAR, cookie, atau `.dev.vars`.
