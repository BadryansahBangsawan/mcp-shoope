# Auth / login

Hop session-only untuk `/connect`. Model tidak pernah memanggil URL ini. Evidence v1: `documented-not-executed` sampai HAR login ter-capture (`observed`).

Password dan OTP hidup hanya di request Connect. Pending OTP di Durable Object **tanpa** password, TTL 10 menit.

## Halaman login

`GET https://shopee.co.id/buyer/login`

Halaman form buyer (tab HP / email). Hop memakai `User-Agent` Chrome + `Accept-Language` (bukan token anti-bot). Cookie `csrftoken` (jika ada) diinjeksikan sebagai header `x-csrftoken`. Status 403 / 3xx → login gagal (fail-closed).

## Submit password

`POST https://shopee.co.id/api/v2/authentication/login`

Body JSON (kunci): `username`, `password` (SHA-256 hex dari password yang diketik), `support_ivs`. Password tidak disimpan. Cookie sesi yang diharapkan: `SPC_EC` / `SPC_ST` (dan `SPC_U` untuk prefix status).

Sukses: envelope tanpa error **dan** cookie `SPC_EC` atau `SPC_ST`. Cookie jar disimpan di Durable Object. Petunjuk OTP (`otp` / `vcode` / `ivs`) → form OTP. Captcha / anti-bot → login gagal.

## Kirim ulang OTP

`POST https://shopee.co.id/api/v2/authentication/resend_otp`

Body JSON (kunci): `username`, `support_ivs`. Pending tetap; cookie jar di-update dari Set-Cookie.

## Verifikasi OTP

`POST https://shopee.co.id/api/v2/authentication/vcode_login`

Body JSON (kunci): `username`, `vcode`, `support_ivs`. OTP 4–8 alfanumerik. Pending dihapus sukses **dan** gagal.

## Bukan hop Worker

SSO Google / Facebook / Apple = 410. Otorisasi Open Platform (`auth_partner`, token shop) = 410.

QR login **bukan hop Worker**. Operator masuk di `GET /connect` (HP/email + password). Worker menjalankan hop di bawah ini; cookie sesi disimpan. Jangan invent hop QR (`gen_qrcode`, `qrcode_login_status`, dll.).

Jangan invent hop login tambahan.
