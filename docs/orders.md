# Orders (riwayat beli)

Pembelian akun buyer, bukan penjualan toko. Evidence: `observed`.

Target: `orders.list`, `orders.detail`, `orders.count`. Id dari list, bukan `order_sn` Open Platform.

`GET https://shopee.co.id/api/v4/order/get_all_order_and_checkout_list`

Query (opsional): `limit`, `offset`. Jangan kirim `_oft` yang diinvent.

`GET https://shopee.co.id/api/v4/order/get_order_detail`

Query: `order_id` (wajib, string). Jangan dump PII penerima.

`GET https://shopee.co.id/api/v4/order/get_order_and_checkout_count`

Query: none. Hitungan tab status.

Read-only. Cancel / checkout = exclusions.
