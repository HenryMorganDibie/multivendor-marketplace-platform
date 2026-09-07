import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { resolveEffectivePlan } from "../subscriptions/resolveEffectivePlan";

const USERNAME_REGEX = /^[a-z0-9_]{3,30}$/;

const USERNAME_COOLDOWN_DAYS = 90;
const USERNAME_CHANGES_PER_YEAR = 2;

interface UsernameChangeRecord {
  changedAt: Date;
  oldUsername: string;
  newUsername: string;
}

/**
 * Mirrors the client's getUsernameChangeEligibility (VendorPlanContext.tsx),
 * which only ever enforced this against a device-local AsyncStorage history —
 * trivially bypassed by reinstalling the app or calling this function
 * directly. This is the authoritative check.
 */
function assertUsernameChangeEligible(history: UsernameChangeRecord[]): void {
  const now = Date.now();
  const yearAgo = now - 365 * 24 * 60 * 60 * 1000;

  const changesThisYear = history.filter((c) => c.changedAt.getTime() > yearAgo);

  if (changesThisYear.length >= USERNAME_CHANGES_PER_YEAR) {
    const oldest = changesThisYear.sort((a, b) => a.changedAt.getTime() - b.changedAt.getTime())[0];
    const nextAvailable = new Date(oldest.changedAt);
    nextAvailable.setFullYear(nextAvailable.getFullYear() + 1);
    const daysUntil = Math.ceil((nextAvailable.getTime() - now) / (24 * 60 * 60 * 1000));
    throw new https.HttpsError(
      "failed-precondition",
      `You've reached the limit of ${USERNAME_CHANGES_PER_YEAR} username changes per year. You can change it again in ${daysUntil} day${daysUntil === 1 ? "" : "s"}.`
    );
  }

  if (history.length > 0) {
    const lastChange = history[history.length - 1];
    const daysSinceLastChange = Math.floor((now - lastChange.changedAt.getTime()) / (24 * 60 * 60 * 1000));
    if (daysSinceLastChange < USERNAME_COOLDOWN_DAYS) {
      const daysUntil = USERNAME_COOLDOWN_DAYS - daysSinceLastChange;
      throw new https.HttpsError(
        "failed-precondition",
        `You can change your username again in ${daysUntil} day${daysUntil === 1 ? "" : "s"}.`
      );
    }
  }
}

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

/** Chars for generated usernames — no vowels, so a random suffix can never
 * accidentally spell a real (possibly offensive) word, and no 0/1/l/o, which
 * are the characters vendors misread when typing a link by hand. */
const TEMP_USERNAME_ALPHABET = "23456789bcdfghjkmnpqrstvwxyz";
const TEMP_USERNAME_PREFIX = "platform_";
const TEMP_USERNAME_SUFFIX_LENGTH = 6;
const TEMP_USERNAME_MAX_ATTEMPTS = 5;

function randomTemporaryUsername(): string {
  let suffix = "";
  for (let i = 0; i < TEMP_USERNAME_SUFFIX_LENGTH; i++) {
    suffix += TEMP_USERNAME_ALPHABET[Math.floor(Math.random() * TEMP_USERNAME_ALPHABET.length)];
  }
  return `${TEMP_USERNAME_PREFIX}${suffix}`;
}

/**
 * generateTemporaryUsername — Phase 1 progressive onboarding.
 *
 * A vendor no longer supplies a username at registration, so the system
 * assigns one immediately (e.g. "platform_k7m2pq") and reserves it through
 * the same transactional path a vendor-chosen username uses. That keeps a
 * single source of truth for uniqueness rather than a second, weaker rule
 * for system-generated names.
 *
 * Collisions are astronomically unlikely (28^6 ≈ 481M) but retried anyway,
 * since a silent collision here would hand two vendors the same storefront
 * URL. Retrying is the difference between "never happens" and "cannot
 * happen".
 */
export async function generateTemporaryUsername(vendorId: string): Promise<string> {
  for (let attempt = 0; attempt < TEMP_USERNAME_MAX_ATTEMPTS; attempt++) {
    const candidate = randomTemporaryUsername();
    try {
      await reserveUsername(candidate, vendorId);
      return candidate;
    } catch (err) {
      const alreadyTaken = err instanceof https.HttpsError && err.code === "already-exists";
      if (!alreadyTaken) throw err;
    }
  }
  throw new https.HttpsError(
    "internal",
    "Could not allocate a temporary username. Please try again."
  );
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

  const { limits: planLimits } = await resolveEffectivePlan(vendorId);
  if (!planLimits.canChangeUsername) {
    throw new https.HttpsError("permission-denied", "Changing your username is not available on your current plan. Upgrade to Standard or above.");
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

    const rawHistory = (vendorSnap.data()?.usernameChangeHistory ?? []) as Array<{
      changedAt: { toDate: () => Date };
      oldUsername: string;
      newUsername: string;
    }>;
    const history: UsernameChangeRecord[] = rawHistory.map((c) => ({
      changedAt: c.changedAt.toDate(),
      oldUsername: c.oldUsername,
      newUsername: c.newUsername,
    }));

    if (oldUsername) {
      // A vendor's very first pick (replacing the system-generated temp
      // username assigned at signup) does not count against the cooldown —
      // only changes away from a username the vendor themselves chose do.
      const hasChosenBefore = history.length > 0 || !oldUsername.startsWith("platform_");
      if (hasChosenBefore) {
        assertUsernameChangeEligible(history);
      }
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
      ...(oldUsername
        ? { usernameChangeHistory: FieldValue.arrayUnion({ changedAt: new Date(), oldUsername, newUsername }) }
        : {}),
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
