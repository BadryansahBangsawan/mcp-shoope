import type { ApiOperation, JsonSchemaLike } from "../types";
import { closedObject, cookieJson, emptyQuery, op } from "./helpers";

const post = { ...cookieJson, method: "POST" as const };

const integer: JsonSchemaLike = { type: "integer" };
const str: JsonSchemaLike = { type: "string" };
const bool: JsonSchemaLike = { type: "boolean" };
const obj: JsonSchemaLike = { type: "object", additionalProperties: true };
const arr: JsonSchemaLike = { type: "array" };

/**
 * Buyer-account reads captured on shopee.co.id (keys-only XHR).
 * Paths and input keys match `.runtime/capture/xhr-keys-round1.json`.
 * `_oft` was present on some GETs; it is not a caller input (do not invent).
 */
export const READ_OPERATIONS: ApiOperation[] = [
  op({
    ...cookieJson,
    operationId: "account.profile",
    title: "Profil akun",
    description: "Profil akun buyer yang terhubung. Tanpa input. Jangan dump PII.",
    pathTemplate: "/api/v4/account/get_profile",
    sourceDocument: "account.md",
    tags: ["account"],
    inputSchema: emptyQuery,
  }),
  op({
    ...cookieJson,
    operationId: "orders.list",
    title: "Daftar pembelian",
    description:
      "Riwayat pembelian akun buyer (bukan penjualan toko). Paginasi limit/offset. Jangan dump PII.",
    pathTemplate: "/api/v4/order/get_all_order_and_checkout_list",
    sourceDocument: "orders.md",
    tags: ["orders"],
    inputSchema: closedObject({
      limit: { ...integer, description: "Page size (capped at 100)." },
      offset: { ...integer, description: "Paging offset from a previous list response." },
    }),
  }),
  op({
    ...cookieJson,
    operationId: "orders.detail",
    title: "Detail pesanan",
    description:
      "Detail satu pesanan. order_id dari orders.list, bukan order_sn Open Platform. Jangan dump PII penerima.",
    pathTemplate: "/api/v4/order/get_order_detail",
    sourceDocument: "orders.md",
    tags: ["orders"],
    inputSchema: closedObject(
      {
        order_id: {
          ...str,
          description: "Id pesanan dari orders.list (string; id Shopee bisa lebih dari 16 digit).",
        },
      },
      ["order_id"],
    ),
  }),
  op({
    ...cookieJson,
    operationId: "orders.count",
    title: "Jumlah pesanan per status",
    description: "Hitungan checkout / to-ship / to-receive untuk akun buyer.",
    pathTemplate: "/api/v4/order/get_order_and_checkout_count",
    sourceDocument: "orders.md",
    tags: ["orders"],
    inputSchema: emptyQuery,
  }),
  op({
    ...post,
    operationId: "cart.get",
    title: "Isi keranjang",
    description:
      "Baca keranjang. POST JSON yang tidak mutasi. Body opsional; {} diterima. Jangan checkout.",
    pathTemplate: "/api/v4/cart/get",
    sourceDocument: "cart.md",
    tags: ["cart"],
    inputSchema: closedObject({
      cart_state: obj,
      pre_selected_item_list: arr,
      start_time: integer,
      updated_time_filter: integer,
      version_list: arr,
    }),
  }),
  op({
    ...cookieJson,
    operationId: "address.list",
    title: "Daftar alamat",
    description: "Baca buku alamat akun. Jangan dump alamat lengkap ke pemanggil kecuali diminta.",
    pathTemplate: "/api/v4/account/address/get_user_address_list",
    sourceDocument: "address.md",
    tags: ["address"],
    inputSchema: closedObject({
      with_warehouse_whitelist_status: integer,
    }),
  }),
  op({
    ...post,
    operationId: "voucher.list",
    title: "Daftar voucher",
    description: "Voucher milik akun. POST JSON read. Jangan klaim/pakai voucher.",
    pathTemplate: "/api/v2/voucher_wallet/get_user_voucher_list",
    sourceDocument: "voucher.md",
    tags: ["voucher"],
    inputSchema: closedObject({
      addition: integer,
      cursor: str,
      exclude_user_voucher_list_type: integer,
      limit: { ...integer, description: "Page size (capped at 100)." },
      need_statistics: bool,
      priority_voucher_list: arr,
      show_red_dot: bool,
      version: integer,
      voucher_sort_flag: integer,
      voucher_status: integer,
    }),
  }),
  op({
    ...post,
    operationId: "voucher.meta",
    title: "Meta daftar voucher",
    description: "Tab/meta voucher wallet. POST JSON tanpa body keys.",
    pathTemplate: "/api/v4/voucher_wallet/get_user_voucher_list_meta",
    sourceDocument: "voucher.md",
    tags: ["voucher"],
    inputSchema: closedObject({}),
  }),
  op({
    ...cookieJson,
    operationId: "notifications.list",
    title: "Notifikasi",
    description: "Pusat notifikasi akun. Read-only; jangan tandai-dibaca.",
    pathTemplate: "/api/v4/notification/get_notifications",
    sourceDocument: "notifications.md",
    tags: ["notifications"],
    inputSchema: closedObject({
      action_cate: integer,
      limit: { ...integer, description: "Page size (capped at 100)." },
    }),
  }),
  op({
    ...cookieJson,
    operationId: "notifications.activities",
    title: "Aktivitas notifikasi",
    description: "Feed aktivitas notifikasi akun.",
    pathTemplate: "/api/v4/notification/get_activities",
    sourceDocument: "notifications.md",
    tags: ["notifications"],
    inputSchema: closedObject({
      limit: { ...integer, description: "Page size (capped at 100)." },
    }),
  }),
  op({
    ...cookieJson,
    operationId: "wallet.overview",
    title: "Ringkasan koin",
    description: "Saldo/koin akun. Bukan ShopeePay send/tarik.",
    pathTemplate: "/api/v4/coin/get_user_coins_summary",
    sourceDocument: "wallet.md",
    tags: ["wallet"],
    inputSchema: emptyQuery,
  }),
  op({
    ...cookieJson,
    operationId: "wallet.transactions",
    title: "Mutasi koin",
    description: "Daftar transaksi koin. Paginasi limit/offset.",
    pathTemplate: "/api/v4/coin/get_user_coin_transaction_list",
    sourceDocument: "wallet.md",
    tags: ["wallet"],
    inputSchema: closedObject({
      limit: { ...integer, description: "Page size (capped at 100)." },
      offset: { ...integer, description: "Paging offset from a previous list response." },
      type: integer,
    }),
  }),
];
