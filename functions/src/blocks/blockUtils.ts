import { db } from "../admin";
import { ACTIVE_ORDER_STATUSES } from "../orders/orderStatus";

/**
 * Block enforcement — the single source of truth for whether a commerce
 * action is allowed between two parties.
 *
 * Rules (per the client's edge-case spec):
 *  - Blocking immediately prevents: new commerce conversations, new
 *    pre-order/inquiry messages, new orders.
 *  - If ANY active order exists between the pair, messaging on that
 *    existing thread remains allowed until ALL active orders reach a
 *    terminal status.
 *  - "Starting new commerce" (new conversation, new order) is ALWAYS
 *    blocked once a block exists, regardless of active orders — the
 *    active-order exception only covers continuing to message on the
 *    existing thread, never creating new commerce.
 *  - Greeting/away messages must never bypass this check — since they are
 *    always triggered as a side effect of the primary send/create path,
 *    they inherit the block decision made there and never run their own
 *    independent check.
 */

export interface BlockCheckResult {
  allowed: boolean;
  reason?: "blocked_no_active_order";
  blockExists: boolean;
}

/**
 * Checks whether an active block exists between two uids, in either
 * direction (blocker/blocked can be either party).
 */
async function findActiveBlock(uidA: string, uidB: string): Promise<boolean> {
  const [aBlockedB, bBlockedA] = await Promise.all([
    db.collection("blocks")
      .where("blockerUid", "==", uidA)
      .where("blockedUid", "==", uidB)
      .where("isActive", "==", true)
      .limit(1)
      .get(),
    db.collection("blocks")
      .where("blockerUid", "==", uidB)
      .where("blockedUid", "==", uidA)
      .where("isActive", "==", true)
      .limit(1)
      .get(),
  ]);

  return !aBlockedB.empty || !bBlockedA.empty;
}

/**
 * canContinueExistingThread — used by sendChatMessage when a thread
 * already exists and the message is NOT starting a new conversation.
 * Allowed if no block exists, OR a block exists but there is at least one
 * active order between the pair.
 */
export async function canContinueExistingThread(
  customerId: string,
  vendorId: string,
  vendorOwnerUid: string
): Promise<BlockCheckResult> {
  const blockExists = await findActiveBlock(customerId, vendorOwnerUid);

  if (!blockExists) {
    return { allowed: true, blockExists: false };
  }

  const activeOrdersSnap = await db.collection("orders")
    .where("vendorId", "==", vendorId)
    .where("customerId", "==", customerId)
    .where("status", "in", ACTIVE_ORDER_STATUSES as unknown as string[])
    .limit(1)
    .get();

  if (!activeOrdersSnap.empty) {
    return { allowed: true, blockExists: true };
  }

  return { allowed: false, reason: "blocked_no_active_order", blockExists: true };
}

/**
 * canStartNewCommerce — used by createCommerceConversation and
 * createOrderFromCart / createExternalOrder. Always denied if any block
 * exists, regardless of active orders — starting new commerce is never
 * permitted once blocked.
 */
export async function canStartNewCommerce(
  customerId: string,
  vendorOwnerUid: string
): Promise<BlockCheckResult> {
  const blockExists = await findActiveBlock(customerId, vendorOwnerUid);
  if (blockExists) {
    return { allowed: false, reason: "blocked_no_active_order", blockExists: true };
  }
  return { allowed: true, blockExists: false };
}

/**
 * Deterministic block document ID so blockUser is naturally idempotent
 * and unblockUser can target the exact document without a query.
 */
export function blockDocId(blockerUid: string, blockedUid: string): string {
  return `${blockerUid}_${blockedUid}`;
}
