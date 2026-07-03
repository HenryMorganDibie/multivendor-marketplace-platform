/**
 * Order status classification helper.
 *
 * Per the client's architectural note: never hard-code status strings across
 * Cloud Functions. All active/terminal checks go through these two
 * functions so that adding a new status (e.g. ready_for_pickup,
 * out_for_delivery in a later phase) requires updating exactly one file.
 */

export const ACTIVE_ORDER_STATUSES = [
  "requested",
  "accepted",
  "confirmed",
  "in_progress",
] as const;

export const TERMINAL_ORDER_STATUSES = [
  "completed",
  "cancelled",
  "rejected",
  "expired",
] as const;

export type ActiveOrderStatus = typeof ACTIVE_ORDER_STATUSES[number];
export type TerminalOrderStatus = typeof TERMINAL_ORDER_STATUSES[number];
export type OrderStatusValue = ActiveOrderStatus | TerminalOrderStatus;

export function isOrderActive(status: string): boolean {
  return (ACTIVE_ORDER_STATUSES as readonly string[]).includes(status);
}

export function isOrderTerminal(status: string): boolean {
  return (TERMINAL_ORDER_STATUSES as readonly string[]).includes(status);
}
