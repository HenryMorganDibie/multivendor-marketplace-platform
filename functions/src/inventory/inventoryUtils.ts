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

export async function adjustInventoryAfterOrder(
  vendorId: string,
  items: OrderItemSnapshot[]
): Promise<void> {
  const batch = db.batch();
  for (const item of items) {
    const itemRef = db.collection("vendors").doc(vendorId).collection("catalogItems").doc(item.itemId);
    const snap = await itemRef.get();
    if (!snap.exists || !snap.data()?.trackInventory) continue;
    const newInventory = Math.max(0, (snap.data()?.inventoryQuantity ?? 0) - item.quantity);
    const newReserved = Math.max(0, (snap.data()?.reservedQuantity ?? 0) - item.quantity);
    batch.update(itemRef, {
      inventoryQuantity: newInventory,
      reservedQuantity: newReserved,
      orderCount: FieldValue.increment(item.quantity),
      isOutOfStock: newInventory <= 0,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
}
