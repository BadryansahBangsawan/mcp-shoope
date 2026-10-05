# shopee-mcp

Remote Cloudflare Worker MCP untuk **satu akun buyer Shopee** (XHR `shopee.co.id`).

URL produksi (setelah deploy): `https://mcp.shopee.badry.engineer/mcp`

## Apa ini

Dua tool: `search` (katalog API) dan `execute` (data hidup akun). Model tidak memilih URL/header/kredensial. Cookie + CSRF diinjeksikan Worker.

Bukan:

- toko seller / Open Platform HMAC
- Seller Centre
- checkout, bayar, follow, autobuy
- scrape toko orang lain

Katalog: profil, riwayat beli, keranjang (read), alamat, voucher, notifikasi, koin. Chat v1 skip (host seller). Mutasi OFF.

## Owner

1. Set `OWNER_PASSWORD` (≥16) dan `SESSION_ENCRYPTION_KEY`.
2. Buka `/login` lalu `/connect`. Masuk dengan HP/email + password akun buyer sendiri. OTP jika Shopee memintanya.
3. Jika login Worker kena captcha/anti-bot, tempel cookie JSON dari browser rumah (`source: browser-export`).
4. Centang hanya `shopee:read` saat klien minta consent.

Lokal: `bun install && cp .dev.vars.example .dev.vars && bun run dev`.

Tes: `bun run check-types && bun run test && bun run coverage:validate && bun run openapi:validate`.

Jangan `wrangler deploy` kecuali diminta.
