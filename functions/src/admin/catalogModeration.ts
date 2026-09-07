import { https, logger } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { writeAuditLog } from "../utils/auditLog";
import { checkAppCheck } from "../utils/appCheck";
import { assertAdmin } from "../utils/adminAuth";
import { newRequestId } from "../utils/requestContext";
import { PENDING_REVISION_DOC_ID } from "../types2";
import { createNotificationInternal } from "../notifications/notificationFunctions";

async function notifyVendorOwner(
  vendorId: string,
  itemId: string,
  itemName: string,
  outcome: "approved" | "rejected",
  reason?: string,
): Promise<void> {
  const vendorSnap = await db.collection("vendors").doc(vendorId).get();
  const vendorOwnerUid = vendorSnap.data()?.ownerUid as string | undefined;
  if (!vendorOwnerUid) return;
  await createNotificationInternal({
    recipientUid: vendorOwnerUid,
    recipientRole: "vendor",
    vendorId,
    type: outcome === "approved" ? "catalog_item_approved" : "catalog_item_rejected",
    domain: "system",
    title: outcome === "approved" ? "Catalog item approved" : "Catalog item needs changes",
    body: outcome === "approved"
      ? `"${itemName}" is now live on your storefront.`
      : `"${itemName}" wasn't approved${reason ? `: ${reason}` : "."}`,
    deepLink: "laetiva://vendor/catalog",
    metadata: { itemId },
    isCritical: false,
  }).catch((err) => logger.error(`createNotificationInternal (catalog_item_${outcome}) failed for item ${itemId}`, err));
}

/**
 * Catalog item moderation — the missing other half of what
 * createCatalogItem already seeds every item with (moderationStatus:
 * "pending"). Same admin roles as moderateRating, the closest existing
 * precedent for approving/rejecting vendor-submitted content.
 */

export const approveCatalogItem = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "approveCatalogItem");
  const admin = await assertAdmin(request, ["super_admin", "safety_admin"]);

  const { vendorId, itemId } = request.data ?? {};
  if (!vendorId || !itemId) throw new https.HttpsError("invalid-argument", "vendorId and itemId are required.");

  const itemRef = db.collection("vendors").doc(vendorId).collection("catalogItems").doc(itemId);
  const itemSnap = await itemRef.get();
  if (!itemSnap.exists) throw new https.HttpsError("not-found", "Catalog item not found.");
  const item = itemSnap.data()!;
  const before = item.moderationStatus;

  // Second gate on category. createCatalogItem already requires one, but items
  // created before that rule existed would otherwise be approvable straight
  // into public view showing "Uncategorized". Approval is the last point where
  // this can be caught, so it is checked here too rather than trusted upstream.
  if (!item.categoryId) {
    throw new https.HttpsError(
      "failed-precondition",
      "This item has no category. It cannot be approved until the vendor assigns one."
    );
  }

  // The proposed edit lives in a private subcollection, not on the item, so
  // customers reading the approved item can never see unreviewed content.
  const revisionRef = itemRef.collection("moderation").doc(PENDING_REVISION_DOC_ID);
  const revisionSnap = await revisionRef.get();
  const pendingChanges = revisionSnap.exists
    ? (revisionSnap.data()?.changes as Record<string, unknown> | undefined)
    : undefined;

  // Phase 2: approving an item that has a pending revision means approving
  // that revision — its proposed values are promoted to become the live
  // version, and the revision is cleared. Approving an item with no revision
  // is the first-time approval of a brand-new item.
  if (pendingChanges && Object.keys(pendingChanges).length > 0) {
    const batch = db.batch();
    batch.update(itemRef, {
      ...pendingChanges,
      hasPendingRevision: false,
      moderationStatus: "approved",
      moderationNotes: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    batch.delete(revisionRef);
    await batch.commit();

    await writeAuditLog({
      requestId, functionName: "approveCatalogItem", actorUid: admin.uid, actorRole: "admin", actorType: "admin",
      targetType: "catalogItem", targetId: itemId, eventType: "catalog.revision_approved",
      before: { moderationStatus: before, liveValues: pickKeys(item, Object.keys(pendingChanges)) },
      after: { promoted: pendingChanges }, appCheck,
    });

    await notifyVendorOwner(vendorId, itemId, item.name ?? "(untitled)", "approved");
    return { success: true, promotedRevision: true };
  }

  await itemRef.update({ moderationStatus: "approved", moderationNotes: null, updatedAt: FieldValue.serverTimestamp() });

  await writeAuditLog({
    requestId, functionName: "approveCatalogItem", actorUid: admin.uid, actorRole: "admin", actorType: "admin",
    targetType: "catalogItem", targetId: itemId, eventType: "catalog.item_approved",
    before: { moderationStatus: before }, after: { moderationStatus: "approved" }, appCheck,
  });

  await notifyVendorOwner(vendorId, itemId, item.name ?? "(untitled)", "approved");
  return { success: true, promotedRevision: false };
});

/** Small helper so the audit log can record what the live values were before a
 * revision replaced them, without dumping the entire document. */
function pickKeys(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = source[k];
  return out;
}

/** Page size for the moderation queue. Bounded deliberately: an unbounded
 * collection-group query over every vendor's catalog is exactly the kind of
 * query that gets expensive as the platform grows. */
const MODERATION_QUEUE_LIMIT = 50;

/**
 * listCatalogModerationQueue — what an admin has to review.
 *
 * Covers both kinds of pending work in one queue, because they need the same
 * decision from the same person:
 *  - brand-new items still on their first review (moderationStatus "pending")
 *  - edits to already-approved items awaiting review (hasPendingRevision)
 *
 * Uses a collection-group query so it spans every vendor rather than needing
 * the caller to know which vendors have outstanding items.
 */
export const listCatalogModerationQueue = https.onCall(async (request) => {
  checkAppCheck(request, "listCatalogModerationQueue");
  await assertAdmin(request, ["super_admin", "safety_admin"]);

  const data = request.data as { cursor?: unknown; limit?: unknown } | undefined;
  const requestedLimit = typeof data?.limit === "number" ? data.limit : MODERATION_QUEUE_LIMIT;
  const pageLimit = Math.min(Math.max(1, Math.floor(requestedLimit)), MODERATION_QUEUE_LIMIT);

  // Oldest first, so the queue is fair: an item submitted on Monday is reviewed
  // before one submitted on Friday, rather than whatever Firestore happens to
  // return. Both orderings need the composite indexes declared in
  // firestore.indexes.json.
  const [pendingSnap, revisionSnap] = await Promise.all([
    db.collectionGroup("catalogItems")
      .where("moderationStatus", "==", "pending")
      .orderBy("createdAt", "asc")
      .limit(pageLimit)
      .get(),
    db.collectionGroup("catalogItems")
      .where("hasPendingRevision", "==", true)
      .orderBy("updatedAt", "asc")
      .limit(pageLimit)
      .get(),
  ]);

  interface QueueEntry {
    vendorId: string;
    itemId: string;
    name: string;
    kind: "new_item" | "revision";
    submittedAt: unknown;
    proposedChanges?: Record<string, unknown>;
    previousRejectionReason?: string | null;
  }

  const newItems: QueueEntry[] = pendingSnap.docs.map((doc) => {
    const d = doc.data();
    return {
      vendorId: d.vendorId,
      itemId: d.itemId ?? doc.id,
      name: d.name ?? "(untitled)",
      kind: "new_item" as const,
      submittedAt: d.createdAt ?? null,
      previousRejectionReason: d.moderationNotes ?? null,
    };
  });

  // The proposed values live in each item's private moderation subcollection,
  // so they have to be fetched per item rather than read off the queue query.
  const revisions: QueueEntry[] = await Promise.all(
    revisionSnap.docs.map(async (doc) => {
      const d = doc.data();
      const revision = await doc.ref.collection("moderation").doc(PENDING_REVISION_DOC_ID).get();
      const r = revision.data();
      return {
        vendorId: d.vendorId,
        itemId: d.itemId ?? doc.id,
        name: d.name ?? "(untitled)",
        kind: "revision" as const,
        submittedAt: r?.submittedAt ?? null,
        proposedChanges: (r?.changes as Record<string, unknown> | undefined) ?? {},
        previousRejectionReason: (r?.rejectionReason as string | undefined) ?? null,
      };
    }),
  );

  return {
    success: true,
    newItems,
    revisions,
    counts: { newItems: newItems.length, revisions: revisions.length },
    // Signals the caller may not be seeing everything outstanding, so a queue
    // UI can say "50+" rather than implying this is the complete list.
    truncated: {
      newItems: pendingSnap.size === pageLimit,
      revisions: revisionSnap.size === pageLimit,
    },
  };
});

export const rejectCatalogItem = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "rejectCatalogItem");
  const admin = await assertAdmin(request, ["super_admin", "safety_admin"]);

  const { vendorId, itemId, reason } = request.data ?? {};
  if (!vendorId || !itemId) throw new https.HttpsError("invalid-argument", "vendorId and itemId are required.");
  if (!reason?.trim()) throw new https.HttpsError("invalid-argument", "reason is required.");

  const itemRef = db.collection("vendors").doc(vendorId).collection("catalogItems").doc(itemId);
  const itemSnap = await itemRef.get();
  if (!itemSnap.exists) throw new https.HttpsError("not-found", "Catalog item not found.");
  const item = itemSnap.data()!;
  const before = item.moderationStatus;

  const revisionRef = itemRef.collection("moderation").doc(PENDING_REVISION_DOC_ID);
  const revisionSnap = await revisionRef.get();
  const pending = revisionSnap.exists
    ? (revisionSnap.data() as { changes?: Record<string, unknown>; submittedAt?: unknown })
    : undefined;

  // Phase 2: rejecting a revision must NOT take the item down. The previously
  // approved version stays live and stays approved — only the proposed edit is
  // refused. Pulling a working listing offline because a later edit was bad
  // would punish the vendor for trying to improve it.
  if (pending?.changes && Object.keys(pending.changes).length > 0) {
    const batch = db.batch();
    batch.set(revisionRef, {
      changes: pending.changes,
      // Keep the original submission time so the vendor can see how long the
      // edit sat before it was refused.
      submittedAt: pending.submittedAt ?? null,
      rejectionReason: reason.trim(),
      status: "rejected",
    });
    // hasPendingRevision stays true: there is still an outstanding edit the
    // vendor needs to deal with, it has just been refused rather than cleared.
    // moderationStatus is deliberately untouched — still "approved".
    batch.update(itemRef, { updatedAt: FieldValue.serverTimestamp() });
    await batch.commit();

    await writeAuditLog({
      requestId, functionName: "rejectCatalogItem", actorUid: admin.uid, actorRole: "admin", actorType: "admin",
      targetType: "catalogItem", targetId: itemId, eventType: "catalog.revision_rejected",
      before: { moderationStatus: before, hadPendingRevision: true },
      after: { moderationStatus: before, revisionStatus: "rejected", reason: reason.trim() }, appCheck,
    });

    await notifyVendorOwner(vendorId, itemId, item.name ?? "(untitled)", "rejected", reason.trim());
    return { success: true, rejectedRevision: true, liveVersionPreserved: true };
  }

  // No revision: this is a first-time item being refused, so the item itself
  // goes to rejected and stays private to the vendor.
  await itemRef.update({
    moderationStatus: "rejected",
    moderationNotes: reason.trim(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAuditLog({
    requestId, functionName: "rejectCatalogItem", actorUid: admin.uid, actorRole: "admin", actorType: "admin",
    targetType: "catalogItem", targetId: itemId, eventType: "catalog.item_rejected",
    before: { moderationStatus: before }, after: { moderationStatus: "rejected", reason: reason.trim() }, appCheck,
  });

  await notifyVendorOwner(vendorId, itemId, item.name ?? "(untitled)", "rejected", reason.trim());
  return { success: true, rejectedRevision: false };
});
