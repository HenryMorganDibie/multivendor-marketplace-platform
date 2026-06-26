import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";

const USERNAME_REGEX = /^[a-z0-9_]{3,30}$/;

export async function reserveUsername(rawUsername: string, vendorId: string): Promise<void> {
  const username = rawUsername.trim().toLowerCase();

  if (!USERNAME_REGEX.test(username)) {
    throw new https.HttpsError(
      "invalid-argument",
      "Username must be 3-30 characters, lowercase letters, numbers, and underscores only."
    );
  }

  const reservationRef = db.collection("usernameReservations").doc(username);

  await db.runTransaction(async (tx) => {
    const existing = await tx.get(reservationRef);

    if (existing.exists && existing.data()?.vendorId !== vendorId) {
      throw new https.HttpsError("already-exists", `Username "@${username}" is already taken.`);
    }

    tx.set(reservationRef, {
      username,
      vendorId,
      reservedAt: FieldValue.serverTimestamp(),
    });
  });
}

export async function releaseUsername(rawUsername: string): Promise<void> {
  const username = rawUsername.trim().toLowerCase();
  await db.collection("usernameReservations").doc(username).delete();
}

/**
 * checkUsernameAvailability — public callable, App Check monitored.
 *
 * Per audit feedback: this is intentionally public (needed pre-auth during
 * onboarding for instant feedback), but is now App-Check-monitored to
 * detect/rate-limit enumeration in monitor mode, with a path to enforcement.
 */
export const checkUsernameAvailability = https.onCall(
  async (request): Promise<{ available: boolean; reason?: string }> => {
    checkAppCheck(request, "checkUsernameAvailability");

    const username = String(request.data?.username ?? "").trim().toLowerCase();

    if (!USERNAME_REGEX.test(username)) {
      return {
        available: false,
        reason: "Username must be 3-30 characters, lowercase letters, numbers, and underscores only.",
      };
    }

    const doc = await db.collection("usernameReservations").doc(username).get();

    if (!doc.exists) {
      return { available: true };
    }

    const ownerVendorId = doc.data()?.vendorId;
    const requesterVendorId = request.auth?.token?.vendorId;

    if (requesterVendorId && ownerVendorId === requesterVendorId) {
      return { available: true };
    }

    return { available: false, reason: "Username is already taken." };
  }
);

/**
 * changeUsername — atomic reassignment, now audited (audit fix from review).
 */
export const changeUsername = https.onCall(async (request): Promise<{ success: true; username: string }> => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "changeUsername");

  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Only vendors can change their username.");
  }

  const vendorId = request.auth.token.vendorId as string | undefined;
  if (!vendorId) {
    throw new https.HttpsError("failed-precondition", "No vendorId on auth token.");
  }

  const newUsername = String(request.data?.username ?? "").trim().toLowerCase();

  if (!USERNAME_REGEX.test(newUsername)) {
    throw new https.HttpsError(
      "invalid-argument",
      "Username must be 3-30 characters, lowercase letters, numbers, and underscores only."
    );
  }

  const vendorRef = db.collection("vendors").doc(vendorId);
  const newReservationRef = db.collection("usernameReservations").doc(newUsername);

  let oldUsername: string | undefined;

  await db.runTransaction(async (tx) => {
    const vendorSnap = await tx.get(vendorRef);
    if (!vendorSnap.exists) {
      throw new https.HttpsError("not-found", "Vendor profile not found.");
    }

    oldUsername = vendorSnap.data()?.username as string | undefined;

    if (oldUsername === newUsername) {
      return; // no-op
    }

    const newReservationSnap = await tx.get(newReservationRef);
    if (newReservationSnap.exists && newReservationSnap.data()?.vendorId !== vendorId) {
      throw new https.HttpsError("already-exists", `Username "@${newUsername}" is already taken.`);
    }

    if (oldUsername) {
      tx.delete(db.collection("usernameReservations").doc(oldUsername));
    }

    tx.set(newReservationRef, {
      username: newUsername,
      vendorId,
      reservedAt: FieldValue.serverTimestamp(),
    });

    tx.update(vendorRef, {
      username: newUsername,
      slug: newUsername,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  if (oldUsername !== newUsername) {
    await writeAuditLog({
      requestId,
      functionName: "changeUsername",
      actorUid: request.auth.uid,
      actorRole: "vendor",
      actorType: "vendor",
      targetType: "vendor",
      targetId: vendorId,
      eventType: "vendor.username_changed",
      before: { username: oldUsername },
      after: { username: newUsername },
      appCheck,
    });
  }

  return { success: true, username: newUsername };
});
