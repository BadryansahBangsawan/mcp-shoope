# Cart

Baca keranjang. Evidence: `observed`. Tulis keranjang = exclusions.

Target: `cart.get`.

`POST https://shopee.co.id/api/v4/cart/get`

Body JSON (opsional): `cart_state`, `pre_selected_item_list`, `start_time`, `updated_time_filter`, `version_list`. `{}` diterima. Ini list-via-POST; `safety: read`.

Jangan klik checkout dari sesi MCP. `POST /api/v4/cart/update` ter-capture sebagai write — lihat exclusions.md.
