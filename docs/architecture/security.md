# Residual risk (Shopee MCP)

## Trust boundary

- Owner password (≥12) + CSRF melindungi `/authorize`, `/login`, `/connect`. Tidak ada pengecualian callback Open Platform.
- Klien MCP memakai OAuth 2.1 (DCR, PKCE S256). `authInfo.token` ke handler = `"redacted"`.
- Dispatcher adalah satu-satunya `fetch`. Sandbox `globalOutbound: null`. Request hanya `operationId|path|query|body`.
- Sesi buyer: AES-GCM v2 + AAD (`sp-shopee-sessions|…`). Cookie jar terenkripsi. Pending OTP **tanpa** password, TTL 10 menit.
- Satu Worker = satu akun. Tidak ada `shop_id`. Tidak ada refresh Open Platform: 401 / login-HTML / 302 ke `/buyer/login` → expire jar (compare-and-delete fingerprint).

## Unofficial XHR

Login Shopee di form `/connect`. Worker POST ke hop ter-capture; cookie jar terenkripsi di Durable Object. Password dan OTP hanya di request, tidak disimpan. Ini XHR tidak resmi — melanggar ToS Shopee (bot/emulator). Bukan mass scrape, bukan checkout, bukan akun orang lain. Rate limit Connect: 10/IP, 6/user, 20 global / 15 menit (kunci di-hash).

## Anti-bot / IP Worker

Shopee sering menolak klien non-browser (`af-ac-enc-*`, captcha, bind IP/UA). Fetch dari IP Cloudflare bisa 403 meski cookie valid. Login Worker bisa gagal.

Dispatcher dan hop login mengirim identitas browser PC (`User-Agent` Chrome, `Accept-Language`, Client Hints `sec-ch-ua*` yang cocok dengan UA, `sec-fetch-*`, `x-api-source: pc`, `x-shopee-language: id`) supaya XHR tidak 403 hanya karena klien terlihat sebagai Worker. Referer mengikuti halaman UI yang punya XHR itu (mis. `/user/purchase` untuk daftar pesanan), bukan selalu beranda. Untuk `orders.list` / `orders.detail` / `cart.get` / `voucher.list`, dispatcher GET HTML halaman itu dulu dan memakai Set-Cookie dari respons hanya di memori request itu (session provider tidak punya save). **Jangan** generate header anti-bot (`af-ac-enc-*`) yang tidak ter-capture. **Jangan** kirim `_oft` / `list_type` yang diinvent. **Jangan** simpan password/OTP. CSRF memakai cookie `csrftoken` di jar (bukan token sesi yang lebih lama).

403 JSON (bukan HTML login) = `FORBIDDEN`, sesi tetap. 403 HTML login = expire. 429 = `SHOPEE_RATE_LIMITED`, sesi tetap.

## Yang tidak dilindungi / residual

- Cookie sesi setara akses akun. Siapa pun dengan sesi Durable Object + owner cookie bisa membaca data akun itu.
- Envelope Shopee sering HTTP 200 + `error`. Mapping salah bisa menahan sesi atau sebaliknya menghapusnya.
- PII (nama, alamat, telepon, isi chat) ada di XHR akun. Tool tidak menyensor field; prompt dan redaksi docs yang menahan dump. Jangan log body pesanan/cookie.
- Mutasi module ada di repo dengan flag mati. Jangan nyalakan tanpa capture write + approval UI + tes.
- Login hop v1 `documented-not-executed` sampai HAR. Drift upstream mungkin gagal login.

## Logging

Jangan log cookie, CSRF, OTP, `vcode`, password owner. Status connect hanya `userPrefix` + `cookieCount` + `source`.
