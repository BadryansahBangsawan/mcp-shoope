# Operasi v1

**12** operasi baca terdaftar (`observed`). **4** hop login session-only. **1** path excluded (`POST /api/v4/cart/update`). Total coverage **17**. Manifest: `docs/architecture/coverage.md`.

| operationId | Status |
| --- | --- |
| `account.profile` | implemented — `GET /api/v4/account/get_profile` |
| `orders.list` | implemented — `GET /api/v4/order/get_all_order_and_checkout_list` |
| `orders.detail` | implemented — `GET /api/v4/order/get_order_detail` (`order_id` string) |
| `orders.count` | implemented — `GET /api/v4/order/get_order_and_checkout_count` |
| `cart.get` | implemented — `POST /api/v4/cart/get` (read) |
| `address.list` | implemented — `GET /api/v4/account/address/get_user_address_list` |
| `voucher.list` | implemented — `POST /api/v2/voucher_wallet/get_user_voucher_list` |
| `voucher.meta` | implemented — `POST /api/v4/voucher_wallet/get_user_voucher_list_meta` |
| `notifications.list` | implemented — `GET /api/v4/notification/get_notifications` |
| `notifications.activities` | implemented — `GET /api/v4/notification/get_activities` |
| `wallet.overview` | implemented — `GET /api/v4/coin/get_user_coins_summary` |
| `wallet.transactions` | implemented — `GET /api/v4/coin/get_user_coin_transaction_list` |
| `chat.conversations` / `chat.messages` | tidak di v1 — host Seller Centre, tidak di-allowlist |

Session-only (bukan Code Mode): `GET /buyer/login`, `POST /api/v2/authentication/login`, `POST …/resend_otp`, `POST …/vcode_login`. Lihat `docs/auth-login.md`.

Excluded: `POST /api/v4/cart/update` (tulis keranjang). Checkout/bayar/kirim-chat/follow/cari-marketplace: prose di `exclusions.md` sampai ada METHOD URL.

Evidence exposed: hanya `observed`. Jangan invent path. Regenerasi: `bun run coverage:report`.
