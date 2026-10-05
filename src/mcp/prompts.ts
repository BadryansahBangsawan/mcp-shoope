import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "riwayat-beli",
    {
      title: "Riwayat pembelian",
      description:
        "Ambil daftar pembelian akun buyer ini. Paginasi, jangan dump.",
      argsSchema: z
        .object({
          days: z.string().optional().describe("Jumlah hari ke belakang (petunjuk; paging dari schema capture)."),
        })
        .default({}),
    },
    ({ days }) => {
      const n = days?.trim() || "14";
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Ambil riwayat pembelian akun ini untuk ${n} hari terakhir (zona Asia/Jakarta).`,
                "1) search katalog untuk orders.list dan orders.detail. Jangan menebak URL di luar katalog.",
                "2) execute orders.list dengan paging dari schema. Jangan kirim cookie, CSRF, method, atau URL.",
                "3) Jangan dump seluruh JSON. Kembalikan ringkasan: jumlah, status, id, waktu.",
                "4) Detail item hanya jika user minta — pakai prompt detail-pesanan.",
                "5) Ini riwayat pembelian akun buyer yang connect, bukan penjualan toko seller.",
                "Read-only. Jangan panggil execute_mutation. Jangan checkout/bayar.",
              ].join("\n"),
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "detail-pesanan",
    {
      title: "Detail pesanan",
      description: "Minta id pesanan dari list, lalu panggil orders.detail (bukan order_sn Open Platform).",
      argsSchema: z
        .object({
          order_id: z.string().optional().describe("Id pesanan dari orders.list. Kosong = tanya user."),
        })
        .default({}),
    },
    ({ order_id }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              order_id?.trim()
                ? `Ambil detail pesanan untuk id: ${order_id.trim()}.`
                : "User belum memberi id pesanan. Tanyakan id dari orders.list sebelum execute.",
              "1) search katalog untuk orders.detail. Jangan menebak URL di luar katalog.",
              "2) execute orders.detail. Jangan kirim cookie atau CSRF.",
              "3) Jangan dump PII (nama, alamat, telepon) ke pemanggil kecuali user secara eksplisit minta dan itu akun miliknya.",
              "Read-only. Jangan panggil execute_mutation.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "ringkas-akun",
    {
      title: "Ringkas akun",
      description: "Profil + voucher + jumlah keranjang. Jangan dump chat.",
      argsSchema: z.object({}).default({}),
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Ringkas akun buyer yang terhubung.",
              "1) search katalog untuk account.profile, voucher.list, cart.get. Lewati yang belum terdaftar.",
              "2) execute yang ada. Jangan dump isi chat atau alamat lengkap.",
              "3) Kembalikan: nama tampilan jika ada, jumlah voucher, jumlah item keranjang.",
              "Read-only. Jangan panggil execute_mutation. Jangan follow, kirim chat, atau checkout.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
