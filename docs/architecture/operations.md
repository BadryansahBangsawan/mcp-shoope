# Operasi v1

Nol operasi baca terdaftar sampai HAR. Empat hop login session-only. Nol path excluded (exclusions.md prose-only). Total coverage **4**.

| operationId | Status |
| --- | --- |
| `account.profile` | menunggu capture |
| `orders.list` / `orders.detail` | menunggu capture |
| `cart.get` | menunggu capture |
| `address.list` | menunggu capture |
| `voucher.list` | menunggu capture |
| `notifications.list` | menunggu capture |
| `chat.conversations` / `chat.messages` | menunggu capture |
| `wallet.overview` | menunggu capture |

Session-only (bukan Code Mode): halaman login, POST login, resend OTP, vcode login. Lihat `docs/auth-login.md`.

Evidence exposed: hanya `observed`. Jangan expose `documented-not-executed` untuk read akun.

Jangan invent path. Manifest: `bun run coverage:report`.
