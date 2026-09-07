import { firestore } from "firebase-admin";
import { db, FieldValue } from "../admin";
import { OrderItemSnapshot } from "../types2";
import { writeOrderEvent } from "../orders/orderEvents";

/**
 * reserveInventory — all reads happen BEFORE the transaction writes.
 * Firestore requires reads-before-writes within a transaction.
 * We pre-fetch item snapshots, validate availability, then write inside tx.
 */
export async function reserveInventory(
  tx: firestore.Transaction,
  vendorId: string,
  orderId: string,
  items: OrderItemSnapshot[]
): Promise<void> {
  // Collect all item refs
  const itemRefs = items.map(item =>
    db.collection("vendors").doc(vendorId).collection("catalogItems").doc(item.itemId)
  );

  // READ all items first (before any writes)
  const snaps = await Promise.all(itemRefs.map(ref => tx.get(ref)));

  // Validate availability for all items before writing anything
  for (let i = 0; i < items.length; i++) {
    const snap = snaps[i];
    const item = items[i];
    if (!snap.exists || !snap.data()?.trackInventory) continue;

    const available = (snap.data()!.inventoryQuantity ?? 0) - (snap.data()!.reservedQuantity ?? 0);
    if (available < item.quantity) {
      throw new Error(
        `INVENTORY_INSUFFICIENT:${item.itemId}:${item.name}:requested=${item.quantity}:available=${available}`
      );
    }
  }

  // Now do all writes (after all reads are done)
  for (let i = 0; i < items.length; i++) {
    const snap = snaps[i];
    const item = items[i];
    if (!snap.exists || !snap.data()?.trackInventory) continue;

    const available = (snap.data()!.inventoryQuantity ?? 0) - (snap.data()!.reservedQuantity ?? 0);
    tx.update(itemRefs[i], {
      reservedQuantity: FieldValue.increment(item.quantity),
      isOutOfStock: (available - item.quantity) <= 0,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
}

export async function releaseInventory(
  vendorId: string,
  orderId: string,
  items: OrderItemSnapshot[],
  reason: string
): Promise<void> {
  const batch = db.batch();
  for (const item of items) {
    const itemRef = db.collection("vendors").doc(vendorId).collection("catalogItems").doc(item.itemId);
    const snap = await itemRef.get();
    if (!snap.exists || !snap.data()?.trackInventory) continue;
    const releaseQty = Math.min(item.quantity, snap.data()?.reservedQuantity ?? 0);
    batch.update(itemRef, {
      reservedQuantity: FieldValue.increment(-releaseQty),
      isOutOfStock: false,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
  await writeOrderEvent({ orderId, vendorId, eventType: "INVENTORY_RELEASED", metadata: { reason, itemCount: items.length } });
}

/**
 * Applies a completed order to its items: stock down for anything tracking it,
 * and the sales counter up.
 *
 * `countsAsSale` separates the two. Stock always moves, because a vendor
 * recording an order they took over the phone has still handed over the goods.
 * The sales counter only moves for internal marketplace orders, because
 * external orders are typed in by the vendor with no second party to them: a
 * vendor could otherwise record external orders against their own item, mark
 * them complete, and earn a Popular tag on numbers nobody else ever saw.
 *
 * That is why this takes a flag rather than reading orderSource itself. The
 * caller knows which kind of order it is holding, and the decision is one the
 * reader should see at the call site.
 */
export async function adjustInventoryAfterOrder(
  vendorId: string,
  items: OrderItemSnapshot[],
  countsAsSale: boolean
): Promise<void> {
  const batch = db.batch();
  for (const item of items) {
    const itemRef = db.collection("vendors").doc(vendorId).collection("catalogItems").doc(item.itemId);
    const snap = await itemRef.get();
    if (!snap.exists) continue;

    // orderCount counts sales, so it is recorded for every item that sold. It
    // used to sit inside the inventory branch below, which meant it only ever
    // incremented for items with inventory tracking switched on. Tracking
    // defaults to off and most categories never turn it on, so the majority of
    // items had a permanent sales count of zero however much they sold. The
    // Popular tag is derived from this field, so it was silently wrong for
    // exactly the vendors who never touch inventory.
    const updates: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (countsAsSale) {
      updates.orderCount = FieldValue.increment(item.quantity);
    }

    // Stock levels only mean anything for items that track them.
    if (snap.data()?.trackInventory) {
      const newInventory = Math.max(0, (snap.data()?.inventoryQuantity ?? 0) - item.quantity);
      const newReserved = Math.max(0, (snap.data()?.reservedQuantity ?? 0) - item.quantity);
      updates.inventoryQuantity = newInventory;
      updates.reservedQuantity = newReserved;
      updates.isOutOfStock = newInventory <= 0;
    }

    batch.update(itemRef, updates);
  }
  await batch.commit();
}
