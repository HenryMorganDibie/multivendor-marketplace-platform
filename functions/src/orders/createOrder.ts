import * as crypto from "crypto";
import { https, logger } from "firebase-functions/v2";
import { db, FieldValue, Timestamp } from "../admin";
import { OrderDoc, OrderItemSnapshot, OrderVendorSnapshot, OrderCustomerSnapshot, CartDoc } from "../types2";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { getNextOrderNumber } from "./orderNumbers";
import { reserveInventory } from "../inventory/inventoryUtils";
import { writeOrderEvent } from "./orderEvents";
import { isCountryActive } from "../utils/countryAvailability";
import { canStartNewCommerce } from "../blocks/blockUtils";
import { injectOrderContext } from "../chat/injectOrderContext";
import { resolveVendorCurrency } from "../vendors/vendorCurrency";
import { resolveEffectivePlan } from "../subscriptions/resolveEffectivePlan";
import { enforceRateLimit } from "../subscriptions/rateLimit";
import { createNotificationInternal } from "../notifications/notificationFunctions";
import { toCustomerDisplayName } from "../utils/customerDisplayName";

const SLA_HOURS = 48;

/**
 * NOTE (Phase 3 change): conversationId is NO LONGER accepted as
 * client-supplied input. Per the Founder's spec, the commerce thread is
 * canonical per (customerId, vendorId) and the backend derives/creates it
 * automatically via injectOrderContext — the frontend never passes a
 * chatId when placing an order.
 */

/**
 * The currency an order is priced in.
 *
 * Every order used to be stamped "NGN" regardless of where the vendor trades,
 * so a vendor in Ghana selling in cedis had their orders, receipts and snapshots
 * all recorded in naira. Nothing errored; the numbers were simply labelled with
 * the wrong currency, permanently, because a snapshot is immutable once written.
 *
 * The country catalogue already carries the currency for all 196 countries, so
 * it is read from there via the vendor's country rather than kept as a second
 * list that can drift. NGN remains the fallback for a vendor whose country
 * predates the catalogue.
 */
// Moved to vendors/vendorCurrency.ts so orders, invoices and catalogue items
// all resolve currency the same way. They did not, and a vendor outside Nigeria
// got their country's currency on orders and NGN on the other two.
// Imported below; see that file for why the client does not get a say.

export const createOrderFromCart = https.onCall(async (request) => {
  await enforceRateLimit(
    request.auth?.uid ?? `ip:${request.rawRequest?.ip ?? "unknown"}`,
    "createOrderFromCart",
    10,
  );
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "createOrderFromCart");
  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");
  const customerId = request.auth.uid;
  const { cartId } = request.data ?? {};
  if (!cartId) throw new https.HttpsError("invalid-argument", "cartId is required.");

  // Order-A idempotency: the order document's ID is the cartId itself, not a
  // random auto-ID. cartId is always server-generated — repriceCart mints a
  // fresh one per pricing attempt, and no mobile caller ever supplies an
  // existing cartId back into repriceCart — so it is exactly as safe a key as
  // a random one, and it turns "does an order already exist for this
  // checkout attempt" into a single direct document lookup.
  //
  // This fast read is a non-authoritative optimization, checked before the
  // cart lookup specifically because a *successful* first attempt deletes the
  // cart in the same transaction that creates the order — a sequential retry
  // (the lost-response case this exists for) would otherwise fail below with
  // "Cart not found" before ever learning the order it's looking for already
  // exists. The transaction further down is the actual authority; this only
  // saves a retried or lightly-racing call the cost of the cart/vendor/
  // catalog work and a vendor order-number allocation it doesn't need.
  const orderRef = db.collection("orders").doc(cartId);
  const fastOrderSnap = await orderRef.get();
  if (fastOrderSnap.exists) {
    const existing = fastOrderSnap.data() as OrderDoc & { conversationId: string };
    return { success: true, orderId: existing.orderId, publicOrderId: existing.publicOrderId, conversationId: existing.conversationId };
  }

  const cartRef = db.collection("carts").doc(cartId);
  const cartSnap = await cartRef.get();
  if (!cartSnap.exists) throw new https.HttpsError("not-found", "Cart not found or has expired.");
  const cart = cartSnap.data() as CartDoc;
  if (cart.customerId !== customerId) throw new https.HttpsError("permission-denied", "This cart does not belong to you.");
  const cartExpiry = (cart.expiresAt as Timestamp).toMillis?.() ?? 0;
  if (cartExpiry > 0 && Date.now() > cartExpiry) throw new https.HttpsError("failed-precondition", "Cart has expired. Please rebuild your cart.");
  if (!cart.items || cart.items.length === 0) throw new https.HttpsError("failed-precondition", "Cart is empty.");

  const [vendorSnap, userSnap] = await Promise.all([db.collection("vendors").doc(cart.vendorId).get(), db.collection("users").doc(customerId).get()]);
  if (!vendorSnap.exists) throw new https.HttpsError("not-found", "Vendor not found.");
  if (!userSnap.exists) throw new https.HttpsError("not-found", "User profile not found.");
  const vendor = vendorSnap.data()!;
  const user = userSnap.data()!;
  if (!vendor.isDiscoverable) throw new https.HttpsError("failed-precondition", "This vendor is not currently accepting orders.");

  // Phase 3 additions: country availability + block check before allowing
  // new commerce (a new order is "new commerce" — no active-order
  // exception applies here, since this order doesn't exist yet). Neither
  // depends on the other's result, so run together.
  const [countryOk, blockCheck] = await Promise.all([
    isCountryActive(vendor.countryCode),
    canStartNewCommerce(customerId, vendor.ownerUid),
  ]);
  if (!countryOk) {
    throw new https.HttpsError("failed-precondition", "Platform is not currently available in this vendor's region.");
  }
  if (!blockCheck.allowed) {
    throw new https.HttpsError("failed-precondition", "You are unable to place an order with this vendor.");
  }

  // Both depend only on `vendor`, already in hand, and not on each other.
  // Only reached once the fast pre-check above has already established no
  // order exists yet for this cartId, so a sequential retry never pays for a
  // vendor order-number allocation it will just discard.
  const [publicOrderId, orderCurrency] = await Promise.all([
    getNextOrderNumber(cart.vendorId, vendor.slug ?? vendor.username, "internal"),
    resolveVendorCurrency(vendor),
  ]);
  const items: OrderItemSnapshot[] = cart.items.map((ci) => ({ itemId: ci.itemId, name: ci.name, basePrice: ci.basePrice, salePrice: ci.salePrice ?? null, quantity: ci.quantity, selectedAddOns: ci.selectedAddOns, lineTotal: ci.lineTotal }));
  const vendorSnapshot: OrderVendorSnapshot = { vendorId: vendor.vendorId, name: vendor.name, username: vendor.username, slug: vendor.slug ?? vendor.username, phone: vendor.phone ?? null, email: vendor.email ?? null, area: vendor.area ?? null, state: vendor.state ?? null, country: vendor.country ?? null };
  const fullName: string = user.profile?.fullName ?? user.displayName ?? "Customer";
  const displayName = toCustomerDisplayName(fullName);
  const customerSnapshot: OrderCustomerSnapshot = { customerId, displayName, photoURL: user.photoURL ?? null };
  const now = FieldValue.serverTimestamp();
  const acceptanceDeadlineAt = Timestamp.fromMillis(Date.now() + SLA_HOURS * 60 * 60 * 1000);

  // conversationId is deterministic — computed the same way
  // createCommerceConversation / injectOrderContext compute it, so it's
  // stable and resolvable even before the thread doc is guaranteed to exist.
  const conversationId = `commerce_${customerId}_${cart.vendorId}`;

  const orderDoc: OrderDoc & { conversationId: string } = {
    orderId: orderRef.id, publicOrderId, vendorId: cart.vendorId, customerId, linkedCustomerId: null,
    orderSource: "internal", conversationId, createdByVendor: false,
    externalCustomerName: null, externalCustomerPhone: null,
    status: "requested", paymentStatus: "UNPAID", fulfillmentType: cart.fulfillmentType,
    orderNote: cart.orderNote ?? null, items,
    orderSnapshot: { subtotal: cart.subtotal, tax: cart.tax, discount: cart.discount, total: cart.total, currency: orderCurrency },
    vendorSnapshot, customerSnapshot, acceptanceDeadlineAt,
    acceptedAt: null, rejectedAt: null, completedAt: null, cancelledAt: null, expiredAt: null,
    createdAt: now, updatedAt: now,
  };

  // The transaction's own tx.get(orderRef) below is the real authority — the
  // fast check above can race another call and both can pass it before
  // either writes, so this re-check (Firestore's read-before-write rule
  // makes it the transaction's first read) is what actually arbitrates
  // between two genuinely concurrent invocations for the same cartId. Only
  // one commits a create; the other's automatically-retried read observes it
  // and returns its identifiers instead — mirroring createExternalOrder's
  // own tx.get-first pattern.
  let createdNow = true;
  let resultOrderId = orderRef.id;
  let resultPublicOrderId = publicOrderId;
  let resultConversationId = conversationId;
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(orderRef);
      if (snap.exists) {
        const existing = snap.data() as OrderDoc & { conversationId: string };
        createdNow = false;
        resultOrderId = existing.orderId;
        resultPublicOrderId = existing.publicOrderId;
        resultConversationId = existing.conversationId;
        return;
      }
      await reserveInventory(tx, cart.vendorId, orderRef.id, items);
      tx.set(orderRef, orderDoc);
      tx.delete(cartRef);
    });
  } catch (err: any) {
    if (err.message?.startsWith("INVENTORY_INSUFFICIENT:")) { const p = err.message.split(":"); throw new https.HttpsError("failed-precondition", `"${p[2]}" does not have enough stock (requested: ${p[3]?.split("=")[1]}, available: ${p[4]?.split("=")[1]}).`); }
    throw err;
  }

  // Order-A: only run post-creation side effects (chat injection, vendor
  // notification, event/audit logs) when this call is the one that actually
  // created the order — a replay that reached this point via the
  // transaction's own re-check must not re-fire any of them.
  if (createdNow) {
    // Four independent post-creation side effects — none reads another's
    // result — run together instead of one after another. Each keeps its
    // own error handling exactly as before (injectOrderContext and the
    // notification already swallow their own failures; still awaited here,
    // not fire-and-forgotten, since a Cloud Function's CPU is not guaranteed
    // to keep running past the point the response is sent).
    await Promise.all([
      writeOrderEvent({ orderId: orderRef.id, vendorId: cart.vendorId, eventType: "ORDER_CREATED", actorUid: customerId, actorRole: "customer", after: { status: "requested", publicOrderId } }),

      // Phase 3: inject order_context into the canonical commerce thread —
      // creates the thread if it doesn't already exist (e.g. customer placed
      // an order via a flow that skipped the pre-order chat step).
      injectOrderContext({
        orderId: orderRef.id,
        publicOrderId,
        vendorId: cart.vendorId,
        vendorOwnerUid: vendor.ownerUid,
        vendorName: vendor.name,
        customerId,
        customerName: displayName,
        status: "requested",
        total: cart.total,
        currency: orderCurrency,
      }).catch((err) => logger.error(`injectOrderContext failed for order ${orderRef.id}`, err)),

      writeAuditLog({ requestId, functionName: "createOrderFromCart", actorUid: customerId, actorRole: "customer", actorType: "customer", targetType: "order", targetId: orderRef.id, eventType: "order.created", after: { orderId: orderRef.id, publicOrderId, total: cart.total }, appCheck }),

      // The vendor's single most time-critical notification — they have
      // SLA_HOURS to respond, and had no way to learn a new order existed
      // short of manually checking the app. Named as an expected trigger
      // alongside the accept/reject/complete/cancel ones in updateOrderStatus.ts
      // but never actually wired anywhere.
      createNotificationInternal({
        recipientUid: vendor.ownerUid,
        recipientRole: "vendor",
        vendorId: cart.vendorId,
        customerId,
        type: "new_order",
        domain: "order",
        title: "New order",
        body: `${displayName} placed an order — respond within ${SLA_HOURS} hours.`,
        deepLink: `platform://chat/${conversationId}`,
        metadata: { orderId: orderRef.id },
        isCritical: true,
      }).catch((err) => logger.error(`createNotificationInternal (new_order) failed for order ${orderRef.id}`, err)),
    ]);
    logger.info(`Order ${publicOrderId} created by customer ${customerId}`);
  } else {
    logger.info(`Order ${resultPublicOrderId} replay for customer ${customerId} (cartId ${cartId}) — no new order created`);
  }

  return { success: true, orderId: resultOrderId, publicOrderId: resultPublicOrderId, conversationId: resultConversationId };
});

/**
 * Deterministic order-document id derived from the caller's submission id.
 * Same idea as paymentLedger.ts's paymentIdFor (a retry reads/writes the
 * same document instead of creating a second one), but NOT the same
 * mechanism: paymentIdFor's character-replace-then-slice is lossy for this
 * purpose. Two distinct raw submissionId values can differ only in
 * characters the replace() strips to the same replacement (e.g. "a.b",
 * "a/b" and "a_b" all become "a_b"), and slice(0, 400) can truncate two
 * long-but-distinct combined strings down to the same prefix — either way,
 * two different accepted inputs would silently address the same order
 * document. A caller-supplied value has no reason to be trusted into a safe
 * charset, so this hashes the whole domain-separated input instead of
 * sanitizing it — collisions become cryptographically infeasible rather
 * than merely unlikely for today's input shapes.
 *
 * vendorId's length is included as an explicit prefix (rather than just a
 * fixed ":" separator between vendorId and submissionId) so the split
 * between the two is unambiguous regardless of what characters either
 * contains — a fixed separator alone would let vendorId="A" + submissionId
 * ="B:C" and vendorId="A:B" + submissionId="C" hash identically. vendorId
 * itself is always request.auth.token.vendorId (backend-resolved, never
 * client-supplied), so this isn't attacker-reachable today, but the
 * encoding is unambiguous on its own merits rather than relying on that.
 */
function externalOrderIdFor(vendorId: string, submissionId: string): string {
  const input = `external-order:${vendorId.length}:${vendorId}:${submissionId}`;
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * A hash of only the fields that describe what the vendor is actually
 * asking to record — not resolved catalog pricing (which can legitimately
 * change between an original attempt and a retry without the vendor having
 * changed anything), not screenshots (never sent to this callable at all),
 * and not any value generated fresh per attempt (a timestamp would make an
 * identical retry hash differently, defeating the point). Two calls with
 * the same submissionId are only the same logical submission if this also
 * matches; otherwise the second call is a materially different request
 * wearing the first one's key, which must not silently overwrite or be
 * mistaken for it.
 */
function externalOrderFingerprint(input: {
  externalCustomerName: string;
  externalCustomerPhone: string | null;
  items: { itemId: string; quantity: number }[];
  fulfillmentType: string;
  orderNote: string | null;
}): string {
  const normalized = {
    externalCustomerName: input.externalCustomerName.trim(),
    externalCustomerPhone: input.externalCustomerPhone?.trim() || null,
    items: input.items
      .map((i) => ({ itemId: String(i.itemId), quantity: i.quantity }))
      .sort((a, b) => a.itemId.localeCompare(b.itemId)),
    fulfillmentType: input.fulfillmentType,
    orderNote: input.orderNote?.trim() || null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export const createExternalOrder = https.onCall(async (request) => {
  await enforceRateLimit(
    request.auth?.uid ?? `ip:${request.rawRequest?.ip ?? "unknown"}`,
    "createExternalOrder",
    20,
  );
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "createExternalOrder");
  if (!request.auth || request.auth.token.role !== "vendor") throw new https.HttpsError("permission-denied", "Only vendors can create external orders.");
  // Backend-resolved from the auth token, never from request.data — a caller
  // must not be able to point the deterministic order key (or anything else
  // here) at a vendor other than their own.
  const vendorId = request.auth.token.vendorId as string;
  const { externalCustomerName, externalCustomerPhone, items: rawItems, fulfillmentType, orderNote, submissionId: rawSubmissionId } = request.data ?? {};
  if (!externalCustomerName?.trim()) throw new https.HttpsError("invalid-argument", "externalCustomerName is required.");
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new https.HttpsError("invalid-argument", "items is required.");

  // submissionId is optional so an older client that never sends it gets
  // exactly today's behavior (random order id, no replay/conflict handling).
  // Bounded and type-checked before it ever reaches ID derivation, rather
  // than trusting the sanitizer alone to make an arbitrary value safe.
  let submissionId: string | undefined;
  if (rawSubmissionId !== undefined && rawSubmissionId !== null) {
    if (typeof rawSubmissionId !== "string" || !rawSubmissionId.trim()) {
      throw new https.HttpsError("invalid-argument", "submissionId must be a non-empty string.");
    }
    if (rawSubmissionId.length > 200) {
      throw new https.HttpsError("invalid-argument", "submissionId is too long.");
    }
    submissionId = rawSubmissionId.trim();
  }

  let orderRef = db.collection("orders").doc();
  let fingerprint: string | undefined;
  if (submissionId) {
    fingerprint = externalOrderFingerprint({
      externalCustomerName,
      externalCustomerPhone: externalCustomerPhone ?? null,
      items: rawItems.map((i: { itemId: string; quantity?: number }) => ({
        itemId: String(i.itemId),
        quantity: Math.max(1, Number(i.quantity) || 1),
      })),
      fulfillmentType: fulfillmentType ?? "pickup",
      orderNote: orderNote ?? null,
    });
    orderRef = db.collection("orders").doc(externalOrderIdFor(vendorId, submissionId));

    /**
     * Optimization only — skips plan/vendor/catalog work entirely for the
     * common replay case and for an obvious conflict, before any of that
     * work is spent. It is NOT the authority: the transaction below re-reads
     * this same document as its first read and makes the real decision, so
     * a race between two first-time submissions of the same key is still
     * resolved correctly even if both pass this check before either writes.
     */
    const fastSnap = await orderRef.get();
    if (fastSnap.exists) {
      const existing = fastSnap.data() as OrderDoc & { conversationId: string; submissionFingerprint?: string };
      if (existing.submissionFingerprint === fingerprint) {
        return { success: true, orderId: existing.orderId, publicOrderId: existing.publicOrderId, conversationId: existing.conversationId };
      }
      throw new https.HttpsError(
        "failed-precondition",
        "This submission was already recorded with different details. Check your Orders list — resubmitting this draft will not update that order."
      );
    }
  }

  // Phase 4 gate: recording orders placed outside the app is a paid feature
  // (Basic cannot). Platform orders via createOrderFromCart are unaffected.
  const { limits: planLimits } = await resolveEffectivePlan(vendorId);
  if (!planLimits.canAccessExternalOrders) {
    throw new https.HttpsError("permission-denied", "External order recording is not available on your current plan.");
  }

  const vendorSnap = await db.collection("vendors").doc(vendorId).get();
  if (!vendorSnap.exists) throw new https.HttpsError("not-found", "Vendor not found.");
  const vendor = vendorSnap.data()!;

  const itemRefs = rawItems.map((i: { itemId: string }) => vendorSnap.ref.collection("catalogItems").doc(i.itemId));
  const itemSnaps = await db.getAll(...itemRefs);
  const items: OrderItemSnapshot[] = [];
  let subtotal = 0;
  for (let i = 0; i < rawItems.length; i++) {
    const snap = itemSnaps[i], raw = rawItems[i];
    if (!snap.exists) throw new https.HttpsError("not-found", `Item ${raw.itemId} not found.`);
    const item = snap.data()!;
    // Moderation gate, per the Phase 2 spec's "cannot be ordered" rule.
    // NOTE (worth a product decision): an external order is the vendor
    // recording a sale that already happened off-platform, so blocking a
    // still-pending item also blocks them from booking real revenue they
    // genuinely took. Rejected items should certainly never produce platform
    // records; "pending" is the arguable case. Following the written spec for
    // now rather than quietly inventing an exception.
    if (item.moderationStatus !== "approved") {
      throw new https.HttpsError(
        "failed-precondition",
        `"${item.name}" is not approved yet, so it can't be added to an order.`
      );
    }
    const qty = Math.max(1, Number(raw.quantity) || 1);
    const lineTotal = (item.salePrice ?? item.basePrice) * qty;
    subtotal += lineTotal;
    items.push({ itemId: item.itemId, name: item.name, basePrice: item.basePrice, salePrice: item.salePrice ?? null, quantity: qty, lineTotal });
  }

  const publicOrderId = await getNextOrderNumber(vendorId, vendor.slug ?? vendor.username, "external");
  const orderCurrency = await resolveVendorCurrency(vendor);
  const now = FieldValue.serverTimestamp();

  // External orders use a placeholder customerId (ext_{orderId}), so they
  // do NOT participate in the canonical commerce-thread model the same
  // way — there is no real customer uid to key a thread on unless
  // linkedCustomerId is set. For MVP, external orders get order_context
  // injected into a synthetic per-order thread rather than a persistent
  // customer-vendor thread, since there's no authenticated customer to
  // link to. This is a known simplification, documented for the Founder.
  const conversationId = `external_${orderRef.id}`;

  const orderDoc: OrderDoc & { conversationId: string; submissionId?: string; submissionFingerprint?: string } = {
    orderId: orderRef.id, publicOrderId, vendorId, customerId: `ext_${orderRef.id}`, linkedCustomerId: null,
    orderSource: "external", conversationId, createdByVendor: true,
    externalCustomerName: externalCustomerName.trim(), externalCustomerPhone: externalCustomerPhone?.trim() ?? null,
    // Not "requested": that status means someone else needs to accept this
    // order, and for a vendor recording a sale that already happened, there
    // is no one else — the vendor accepting their own record 48 hours after
    // recording it was never a real gate, just the internal-order lifecycle
    // applied somewhere it doesn't fit. Created already accepted; fulfillment
    // and completion still happen normally from there.
    status: "accepted", paymentStatus: "UNPAID", fulfillmentType: fulfillmentType ?? "pickup",
    orderNote: orderNote ?? null, items,
    orderSnapshot: { subtotal, tax: 0, discount: 0, total: subtotal, currency: orderCurrency },
    vendorSnapshot: { vendorId, name: vendor.name, username: vendor.username, slug: vendor.slug ?? vendor.username },
    customerSnapshot: { customerId: `ext_${orderRef.id}`, displayName: externalCustomerName.trim(), photoURL: null },
    // Unused for an order created already-accepted (nothing in the backend
    // reads this field outside its own declaration) — set to now rather
    // than a real deadline, since there is nothing left to accept before.
    acceptanceDeadlineAt: now,
    acceptedAt: now, rejectedAt: null, completedAt: null, cancelledAt: null, expiredAt: null,
    // Ledger projection defaults, External Orders only — createOrderFromCart
    // (internal orders) deliberately does not set these; recordPayment and
    // reversePayment only read/write them when orderSource === "external".
    ledgerAmountPaidMinorUnits: 0, ledgerPaymentStatus: "unpaid", lastLedgerActivityAt: null,
    createdAt: now, updatedAt: now,
    ...(submissionId ? { submissionId, submissionFingerprint: fingerprint } : {}),
  };

  /**
   * The authority. tx.get(orderRef) is this transaction's first read (before
   * reserveInventory's own per-item reads), satisfying Firestore's
   * read-before-write rule. It re-checks existence even though the fast
   * path above already looked, because two first-time submissions of the
   * same key can both pass that check before either has written — only one
   * of these transactions will see `exists: false` and actually create the
   * order; Firestore's optimistic-concurrency retry handles the rest.
   *
   * On a fingerprint mismatch this throws a plain, local Error rather than
   * an HttpsError — matching how INVENTORY_INSUFFICIENT is signalled out of
   * createOrderFromCart's transaction elsewhere in this file — and is
   * converted to a proper HttpsError just outside the transaction.
   */
  let createdNow = true;
  let resultOrderId = orderRef.id;
  let resultPublicOrderId = publicOrderId;
  let resultConversationId = conversationId;
  try {
    await db.runTransaction(async (tx) => {
      if (submissionId) {
        const snap = await tx.get(orderRef);
        if (snap.exists) {
          const existing = snap.data() as OrderDoc & { conversationId: string; submissionFingerprint?: string };
          if (existing.submissionFingerprint !== fingerprint) {
            throw new Error("SUBMISSION_CONFLICT");
          }
          createdNow = false;
          resultOrderId = existing.orderId;
          resultPublicOrderId = existing.publicOrderId;
          resultConversationId = existing.conversationId;
          return;
        }
      }
      await reserveInventory(tx, vendorId, orderRef.id, items);
      tx.set(orderRef, orderDoc);
    });
  } catch (err: any) {
    if (err.message === "SUBMISSION_CONFLICT") {
      throw new https.HttpsError(
        "failed-precondition",
        "This submission was already recorded with different details. Check your Orders list — resubmitting this draft will not update that order."
      );
    }
    throw err;
  }

  if (createdNow) {
    await writeOrderEvent({ orderId: orderRef.id, vendorId, eventType: "ORDER_CREATED", actorUid: request.auth!.uid, actorRole: "vendor", after: { publicOrderId, orderSource: "external" } });
    await writeAuditLog({ requestId, functionName: "createExternalOrder", actorUid: request.auth!.uid, actorRole: "vendor", actorType: "vendor", targetType: "order", targetId: orderRef.id, eventType: "order.external_created", after: { orderId: orderRef.id, publicOrderId }, appCheck });
  }
  return { success: true, orderId: resultOrderId, publicOrderId: resultPublicOrderId, conversationId: resultConversationId };
});
