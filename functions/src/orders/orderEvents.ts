import { db, FieldValue } from "../admin";
import { OrderEventDoc, OrderEventType } from "../types2";

interface WriteOrderEventParams {
  orderId: string; vendorId: string; eventType: OrderEventType;
  actorUid?: string | null; actorRole?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

export async function writeOrderEvent(params: WriteOrderEventParams): Promise<string> {
  const eventRef = db.collection("orders").doc(params.orderId).collection("events").doc();
  const event: OrderEventDoc = {
    eventId: eventRef.id, orderId: params.orderId, vendorId: params.vendorId,
    eventType: params.eventType, actorUid: params.actorUid ?? null,
    actorRole: params.actorRole ?? null, before: params.before ?? null,
    after: params.after ?? null, metadata: params.metadata ?? {},
    createdAt: FieldValue.serverTimestamp(),
  };
  await eventRef.set(event);
  return eventRef.id;
}
