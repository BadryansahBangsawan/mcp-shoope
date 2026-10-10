# Orders (riwayat beli)

Pembelian akun buyer, bukan penjualan toko. Evidence: `observed`.

Target: `orders.list`, `orders.detail`, `orders.count`. Id dari list, bukan `order_sn` Open Platform.

`GET https://shopee.co.id/api/v4/order/get_all_order_and_checkout_list`

Query (opsional): `limit`, `offset`. Jangan kirim `_oft` atau `list_type` yang diinvent. Dispatcher memakai Referer `https://shopee.co.id/user/purchase` (bukan input pemanggil). Sebelum XHR daftar/detail, GET HTML halaman itu dan pakai Set-Cookie-nya hanya untuk request yang sama (tidak disimpan ke Durable Object).

`GET https://shopee.co.id/api/v4/order/get_order_detail`

Query: `order_id` (wajib, string). Jangan dump PII penerima.

`GET https://shopee.co.id/api/v4/order/get_order_and_checkout_count`

Query: none. Hitungan tab status.

Jika Worker mendapat 403 JSON (`error: 90309999`, `is_login: true`) untuk `orders.list` / `orders.detail`, dispatcher menyajikan snapshot terakhir dari browser lokal (`from_snapshot: true`, `pulled_at`). Snapshot diimpor owner-gated `POST /connect/orders-import` setelah `bun run orders:pull` (Playwright Chromium, profil `.runtime/auth/pw-profile`), `bun run orders:pull-brave` (Brave headed + QR di halaman resmi Shopee, profil `.runtime/auth/brave-qr-profile`; bukan hop Worker), atau `bun run orders:pull-cdp` (attach CDP ke Brave copy-profile yang sudah login; jangan `page.goto`). `GET /connect/status` hanya counts snapshot (`present`, `pulledAt`, `listCount`, `detailCount`), bukan id pesanan. Disconnect menghapus snapshot; 401 fingerprint-clear tidak. Jangan dump PII.

Read-only. Cancel / checkout = exclusions.
