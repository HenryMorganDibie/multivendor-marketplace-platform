import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { BlockDoc, BlockedSnapshot } from "../types3";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { blockDocId } from "./blockUtils";

function computeInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ─── blockUser ──────────────────────────────────────────────────────────────

export const blockUser = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "blockUser");

  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");

  const blockerUid = request.auth.uid;
  const blockerRole = request.auth.token.role as "customer" | "vendor" | undefined;
  const { blockedUid, reason } = request.data ?? {};

  if (!blockedUid) throw new https.HttpsError("invalid-argument", "blockedUid is required.");
  if (blockedUid === blockerUid) throw new https.HttpsError("invalid-argument", "Cannot block yourself.");
  if (!blockerRole) throw new https.HttpsError("failed-precondition", "Blocker role could not be determined.");

  const blockedUserSnap = await db.collection("users").doc(blockedUid).get();
  if (!blockedUserSnap.exists) throw new https.HttpsError("not-found", "User to block was not found.");
  const blockedUser = blockedUserSnap.data()!;
  const blockedRole: "customer" | "vendor" = blockedUser.role;

  // Build the display snapshot at block time — never updated after creation
  let displayName = blockedUser.profile?.fullName ?? blockedUser.displayName ?? "User";
  let businessName: string | null = null;
  let vendorId: string | null = null;
  let customerId: string | null = null;

  if (blockedRole === "vendor" && blockedUser.vendorId) {
    vendorId = blockedUser.vendorId;
    const vendorSnap = await db.collection("vendors").doc(blockedUser.vendorId).get();
    if (vendorSnap.exists) {
      businessName = vendorSnap.data()?.name ?? null;
      displayName = businessName ?? displayName;
    }
  } else {
    customerId = blockedUid;
  }

  if (blockerRole === "vendor") {
    vendorId = request.auth.token.vendorId as string ?? vendorId;
  } else {
    customerId = customerId ?? blockerUid;
  }

  const blockedSnapshot: BlockedSnapshot = {
    displayName,
    businessName,
    photoURL: blockedUser.photoURL ?? null,
    initials: computeInitials(displayName),
    role: blockedRole,
  };

  const blockId = blockDocId(blockerUid, blockedUid);
  const blockRef = db.collection("blocks").doc(blockId);
  const now = FieldValue.serverTimestamp();

  const blockDoc: BlockDoc = {
    blockId,
    blockerUid,
    blockedUid,
    blockerRole,
    blockedRole,
    vendorId,
    customerId,
    blockedSnapshot,
    reason: reason?.trim() ?? null,
    blockedAt: now,
    isActive: true,
    unblockedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  // set (not create) — idempotent if the same block is re-applied after a
  // prior unblock, since blockId is deterministic per pair.
  await blockRef.set(blockDoc);

  await writeAuditLog({
    requestId,
    functionName: "blockUser",
    actorUid: blockerUid,
    actorRole: blockerRole,
    actorType: blockerRole,
    targetType: "user",
    targetId: blockedUid,
    eventType: "block.created",
    metadata: reason ? { reason } : undefined,
    appCheck,
  });

  return { success: true, blockId };
});

// ─── unblockUser ────────────────────────────────────────────────────────────

export const unblockUser = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "unblockUser");

  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");

  const blockerUid = request.auth.uid;
  const { blockedUid } = request.data ?? {};
  if (!blockedUid) throw new https.HttpsError("invalid-argument", "blockedUid is required.");

  const blockId = blockDocId(blockerUid, blockedUid);
  const blockRef = db.collection("blocks").doc(blockId);
  const blockSnap = await blockRef.get();

  if (!blockSnap.exists) throw new https.HttpsError("not-found", "Block record not found.");

  const block = blockSnap.data() as BlockDoc;
  if (block.blockerUid !== blockerUid) {
    throw new https.HttpsError("permission-denied", "Only the person who created the block can remove it.");
  }
  if (!block.isActive) {
    throw new https.HttpsError("failed-precondition", "This user is not currently blocked.");
  }

  const now = FieldValue.serverTimestamp();
  await blockRef.update({
    isActive: false,
    unblockedAt: now,
    updatedAt: now,
  });

  await writeAuditLog({
    requestId,
    functionName: "unblockUser",
    actorUid: blockerUid,
    actorRole: block.blockerRole,
    actorType: block.blockerRole,
    targetType: "user",
    targetId: blockedUid,
    eventType: "block.removed",
    appCheck,
  });

  return { success: true };
});
