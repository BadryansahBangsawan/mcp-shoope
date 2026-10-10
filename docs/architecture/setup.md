# Setup (operator)

## 1. Secrets Worker

```
OWNER_PASSWORD            ≥12 karakter
SESSION_ENCRYPTION_KEY    openssl rand -base64 32
```

Tidak ada partner id/key. Tidak ada `shop_id`.

KV `OAUTH_KV` **baru** saat deploy. Jangan copy id KV/DO dari Worker lain.

## 2. Lokal

```
bun install
cp .dev.vars.example .dev.vars
# isi OWNER_PASSWORD, SESSION_ENCRYPTION_KEY; DEV_PSK opsional untuk skrip lokal
bun run check-types && bun run test && bun run coverage:validate && bun run openapi:validate
bun run dev
curl http://localhost:8787/healthz
```

Connect: buka `/login` lalu `/connect`. Masuk dengan akun Shopee (HP/email + password). Cookie sesi disimpan di Durable Object. OTP jika diminta.

Buka `/mcp` di browser tanpa Bearer = **401** (RFC 6750). Cek hidup lewat `/healthz`.

## 3. Capture (prasyarat operasi read)

Read v1 sudah `observed` (12 ops). Capture lanjutan hanya untuk path baru. Login di browser sendiri ke `shopee.co.id`. Export Network (HAR keys-only). Jangan commit HAR/cookie. Isi `docs/*.md` lalu daftarkan ops dengan evidence `observed`. Snapshot pesanan: `bun run orders:pull` (profil Playwright), `bun run orders:pull-brave` (QR Brave lokal, bukan hop Connect), atau `bun run orders:pull-cdp` (CDP ke Brave copy-profile) lalu impor owner. Body `voucher.list`: recapture headed (`bun run voucher:capture-body` / `orders:pull-cdp`); jangan invent integer.

Tanpa sesi Connect: `execute` gagal `SHOPEE_AUTH_EXPIRED`. Chat **tidak** di v1: tab ChatEasy memakai `seller.shopee.co.id` (tidak di-allowlist; jangan tulis METHOD URL).

## 4. Deploy

Domain custom `mcp.shopee.badry.engineer`, `workers_dev: false`. DNS CNAME ke Worker. WAF: izinkan `160.79.104.0/21` jika Authorize Claude.ai terblokir.

Deploy **tidak** menyalin Durable Object / cookie jar lokal. Operator harus Connect ulang di produksi. Jangan copy id KV/DO dari Worker lain.
