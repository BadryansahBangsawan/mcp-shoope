# Account

Profil akun buyer. Evidence: `observed` (XHR keys-only).

Target: `account.profile`.

`GET https://shopee.co.id/api/v4/account/get_profile`

Query: none. Cookie sesi + header `x-csrftoken`. Envelope JSON (`error`, `data`). Jangan dump nama, email, telepon.

Bukan HMAC partner. Bukan Open Platform.
