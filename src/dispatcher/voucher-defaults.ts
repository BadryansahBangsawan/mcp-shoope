/**
 * Dispatcher-side fill for voucher.list when the caller omits a body.
 * Values copied from the voucher-wallet page's own POST
 * (`.runtime/capture/voucher-list-body.json`). Do not invent replacements.
 */
export const VOUCHER_LIST_FILL: Record<string, unknown> = {
  addition: ["voucher_microsite_link"],
  cursor: "",
  exclude_user_voucher_list_type: [],
  limit: 50,
  need_statistics: true,
  priority_voucher_list: null,
  show_red_dot: false,
  version: 7,
  voucher_sort_flag: 6,
  voucher_status: 1,
};

export function fillVoucherListBody(body: unknown): Record<string, unknown> {
  const src =
    body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return { ...VOUCHER_LIST_FILL, ...src };
}
