# Residual risk (Shopee MCP)

## Trust boundary

- Owner password (≥16) + CSRF melindungi `/authorize`, `/login`, `/connect`. Tidak ada pengecualian callback Open Platform.
- Klien MCP memakai OAuth 2.1 (DCR, PKCE S256). `authInfo.token` ke handler = `"redacted"`.
- Dispatcher adalah satu-satunya `fetch`. Sandbox `globalOutbound: null`. Request hanya `operationId|path|query|body`.
- Sesi buyer: AES-GCM v2 + AAD (`sp-shopee-sessions|…`). Cookie jar terenkripsi. Pending OTP **tanpa** password, TTL 10 menit.
- Satu Worker = satu akun. Tidak ada `shop_id`. Tidak ada refresh Open Platform: 401 / login-HTML / 302 ke `/buyer/login` → expire jar (compare-and-delete fingerprint).

## Unofficial XHR

Produk meniru form login resmi akun **milik operator** untuk baca data akun itu. Ini melanggar ToS Shopee (bot/emulator tidak resmi). Bukan mass scrape, bukan checkout, bukan akun orang lain. Rate limit Connect: 10/IP, 6/user, 20 global / 15 menit (kunci di-hash).

## Anti-bot / IP Worker

Shopee sering menolak klien non-browser (`af-ac-enc-*`, captcha, bind IP/UA). Fetch dari IP Cloudflare bisa 403 meski cookie valid. Login Worker bisa gagal; paste dari browser rumah bisa tetap 403 saat di-replay.

Fail-closed: `needs_paste` / `SHOPEE_AUTH_EXPIRED` / `UPSTREAM_ERROR`. Owner reconnect. **Jangan** generate header anti-bot yang tidak ter-capture. **Jangan** simpan password/OTP.

403 JSON (bukan HTML login) = `FORBIDDEN`, sesi tetap. 403 HTML login = expire. 429 = `SHOPEE_RATE_LIMITED`, sesi tetap.

## Yang tidak dilindungi / residual

- Cookie sesi setara akses akun. Siapa pun dengan paste cookie + owner cookie bisa membaca data akun itu.
- Envelope Shopee sering HTTP 200 + `error`. Mapping salah bisa menahan sesi atau sebaliknya menghapusnya.
- PII (nama, alamat, telepon, isi chat) ada di XHR akun. Tool tidak menyensor field; prompt dan redaksi docs yang menahan dump. Jangan log body pesanan/cookie.
- Mutasi module ada di repo dengan flag mati. Jangan nyalakan tanpa capture write + approval UI + tes.
- Login hop v1 `documented-not-executed` sampai HAR. Drift upstream mungkin gagal login → paste.

## Logging

Jangan log cookie, CSRF, OTP, `vcode`, password owner. Status connect hanya `userPrefix` + `cookieCount` + `source`.
