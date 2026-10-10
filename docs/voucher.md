# Voucher

Voucher milik akun. Evidence: `observed`. Klaim/pakai = exclusions.

Target: `voucher.list`, `voucher.meta`.

`POST https://shopee.co.id/api/v2/voucher_wallet/get_user_voucher_list`

Body JSON (opsional): `addition`, `cursor`, `exclude_user_voucher_list_type`, `limit`, `need_statistics`, `priority_voucher_list`, `show_red_dot`, `version`, `voucher_sort_flag`, `voucher_status`. List-via-POST; `safety: read`. Dispatcher mengisi kunci yang hilang dari recapture headed POST halaman voucher-wallet (`bun run voucher:capture-body`, `bun run orders:pull-brave`, atau `bun run orders:pull-cdp`); jangan invent integer. `{}` tetap diterima.

`POST https://shopee.co.id/api/v4/voucher_wallet/get_user_voucher_list_meta`

Body: `{}`.
