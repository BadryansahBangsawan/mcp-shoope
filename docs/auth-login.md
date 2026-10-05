# Auth / login

Hop session-only untuk `/connect`. Model tidak pernah memanggil URL ini. Evidence v1: `documented-not-executed` sampai HAR login ter-capture (`observed`).

Password dan OTP hidup hanya di request Connect. Pending OTP di Durable Object **tanpa** password, TTL 10 menit.

## Halaman login

`GET https://shopee.co.id/buyer/login`

Halaman form buyer (tab HP / email). Cookie `csrftoken` (jika ada) diinjeksikan sebagai header `x-csrftoken`. Status 403 / 3xx → Connect menampilkan paste.

## Submit password

`POST https://shopee.co.id/api/v2/authentication/login`

Body JSON (kunci): `username`, `password` (SHA-256 hex dari password yang diketik), `support_ivs`. Password tidak disimpan. Cookie sesi yang diharapkan: `SPC_EC` / `SPC_ST` (dan `SPC_U` untuk prefix status).

Sukses: envelope tanpa error **dan** cookie `SPC_EC` atau `SPC_ST`. Petunjuk OTP (`otp` / `vcode` / `ivs`) → form OTP. Captcha / anti-bot → paste.

## Kirim ulang OTP

`POST https://shopee.co.id/api/v2/authentication/resend_otp`

Body JSON (kunci): `username`, `support_ivs`. Pending tetap; cookie jar di-update dari Set-Cookie.

## Verifikasi OTP

`POST https://shopee.co.id/api/v2/authentication/vcode_login`

Body JSON (kunci): `username`, `vcode`, `support_ivs`. OTP 4–8 alfanumerik. Pending dihapus sukses **dan** gagal.

## Bukan hop Worker

SSO Google / Facebook / Apple = 410. Otorisasi Open Platform (`auth_partner`, token shop) = 410. QR login tidak didaftarkan sampai ter-capture.

Jangan invent hop login tambahan.
