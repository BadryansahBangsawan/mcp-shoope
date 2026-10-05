# Setup (operator)

## 1. Secrets Worker

```
OWNER_PASSWORD            ≥16 karakter
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

Connect: buka `/login` → `/connect` → masuk HP/email. Jika captcha, tempel cookie JSON dari browser rumah.

Bundle paste:

```
{ "v": 1, "source": "browser-export", "cookies": [{ "name", "value", "domain", "path" }] }
```

Hanya domain `shopee.co.id` / `*.shopee.co.id`. Cookie pihak ketiga di-drop.

## 3. Capture (prasyarat operasi read)

Login di browser sendiri ke `shopee.co.id`. Export Network (HAR keys-only) atau catat DevTools. Jangan commit HAR/cookie. Isi checklist di `docs/*.md` lalu daftarkan ops dengan evidence `observed`.

Tanpa sesi Connect: `execute` gagal `SHOPEE_AUTH_EXPIRED`. Chat masih menunggu capture di host yang di-allowlist.

## 4. Deploy

Hanya jika operator minta. Domain custom `mcp.shopee.badry.engineer`, `workers_dev: false`. DNS CNAME ke Worker. WAF: izinkan `160.79.104.0/21` jika klien Claude.ai.
