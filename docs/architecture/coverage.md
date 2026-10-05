# API coverage

<!-- Generated from src/registry (operations + exclusions). Do not edit by hand: run `bun run scripts/validate-coverage.ts --write-report`. -->

Every METHOD + host + path documented in the API docs under `docs/` has exactly one entry below.
`tests/unit/coverage.test.ts` extracts the endpoints from the markdown and fails on any gap, duplicate,
undocumented entry, exposed failed probe, or missing impl/test file.

```bash
bun run coverage:validate
bun run openapi:validate
```

## Totals

| Status | Count |
| --- | --- |
| implemented | 12 |
| html-adapter | 0 |
| mutation-gated | 0 |
| session-only | 4 |
| excluded | 1 |
| **total** | **17** |

## Policy

- Bentuk A (`METHOD https://shopee.co.id/path`) only; Worker Connect URLs are not extracted
- Buyer login hops (`/buyer/login`, `authentication/login`, `resend_otp`, `vcode_login`) → `session-only` (`/connect`)
- Account reads are `implemented` only after a captured HAR (`observed`)
- Checkout / pay / chat-send / follow / marketplace search / Open Platform → prose in exclusions.md until a METHOD URL is captured then excluded
- Captured cart write (`POST /api/v4/cart/update`) → `excluded`
- Mutations without a captured XHR → not in this table (ENABLE_MUTATIONS stays false)
- HTML adapters are not planned in v1
- Implemented JSON operations cite `tests/unit/coverage.test.ts`; dispatcher behaviour is covered in `tests/unit/dispatcher.test.ts`

No sample credentials, cookies, CSRF, OTP, password, or buyer PII appear here.

## Entries

| Source md | Method host path | operationId | Auth | R/W | Impl module | Test file | Status | Exclusion reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `account.md` | `GET www /api/v4/account/get_profile` | `account.profile` | cookie-csrf | R | `src/dispatcher/shopee-dispatcher.ts` | `tests/unit/coverage.test.ts` | implemented | — |
| `address.md` | `GET www /api/v4/account/address/get_user_address_list` | `address.list` | cookie-csrf | R | `src/dispatcher/shopee-dispatcher.ts` | `tests/unit/coverage.test.ts` | implemented | — |
| `auth-login.md` | `POST www /api/v2/authentication/login` | — | cookie-csrf | R | `src/connect/login-flow.ts` | `tests/unit/connect.test.ts` | session-only | Buyer login hop used by /connect; model never calls this. |
| `auth-login.md` | `POST www /api/v2/authentication/resend_otp` | — | cookie-csrf | R | `src/connect/login-flow.ts` | `tests/unit/connect.test.ts` | session-only | Buyer login hop used by /connect; model never calls this. |
| `auth-login.md` | `POST www /api/v2/authentication/vcode_login` | — | cookie-csrf | R | `src/connect/login-flow.ts` | `tests/unit/connect.test.ts` | session-only | Buyer login hop used by /connect; model never calls this. |
| `auth-login.md` | `GET www /buyer/login` | — | cookie-csrf | R | `src/connect/login-flow.ts` | `tests/unit/connect.test.ts` | session-only | Buyer login hop used by /connect; model never calls this. |
| `cart.md` | `POST www /api/v4/cart/get` | `cart.get` | cookie-csrf | R | `src/dispatcher/shopee-dispatcher.ts` | `tests/unit/coverage.test.ts` | implemented | — |
| `exclusions.md` | `POST www /api/v4/cart/update` | — | cookie-csrf | W | — | — | excluded | Cart write (quantity/select/checkout prep). Not a Code Mode operation. |
| `notifications.md` | `GET www /api/v4/notification/get_activities` | `notifications.activities` | cookie-csrf | R | `src/dispatcher/shopee-dispatcher.ts` | `tests/unit/coverage.test.ts` | implemented | — |
| `notifications.md` | `GET www /api/v4/notification/get_notifications` | `notifications.list` | cookie-csrf | R | `src/dispatcher/shopee-dispatcher.ts` | `tests/unit/coverage.test.ts` | implemented | — |
| `orders.md` | `GET www /api/v4/order/get_all_order_and_checkout_list` | `orders.list` | cookie-csrf | R | `src/dispatcher/shopee-dispatcher.ts` | `tests/unit/coverage.test.ts` | implemented | — |
| `orders.md` | `GET www /api/v4/order/get_order_and_checkout_count` | `orders.count` | cookie-csrf | R | `src/dispatcher/shopee-dispatcher.ts` | `tests/unit/coverage.test.ts` | implemented | — |
| `orders.md` | `GET www /api/v4/order/get_order_detail` | `orders.detail` | cookie-csrf | R | `src/dispatcher/shopee-dispatcher.ts` | `tests/unit/coverage.test.ts` | implemented | — |
| `voucher.md` | `POST www /api/v2/voucher_wallet/get_user_voucher_list` | `voucher.list` | cookie-csrf | R | `src/dispatcher/shopee-dispatcher.ts` | `tests/unit/coverage.test.ts` | implemented | — |
| `voucher.md` | `POST www /api/v4/voucher_wallet/get_user_voucher_list_meta` | `voucher.meta` | cookie-csrf | R | `src/dispatcher/shopee-dispatcher.ts` | `tests/unit/coverage.test.ts` | implemented | — |
| `wallet.md` | `GET www /api/v4/coin/get_user_coin_transaction_list` | `wallet.transactions` | cookie-csrf | R | `src/dispatcher/shopee-dispatcher.ts` | `tests/unit/coverage.test.ts` | implemented | — |
| `wallet.md` | `GET www /api/v4/coin/get_user_coins_summary` | `wallet.overview` | cookie-csrf | R | `src/dispatcher/shopee-dispatcher.ts` | `tests/unit/coverage.test.ts` | implemented | — |
