import { db, FieldValue, Timestamp } from "../admin";
import { SubscriptionLockDoc } from "../types4";

const LOCK_TTL_MS = 10_000;

export class LockContentionError extends Error {
  constructor(public readonly vendorId: string) {
    super(`Subscription for vendor ${vendorId} is already being mutated.`);
    this.name = "LockContentionError";
  }
}

/**
 * acquireSubscriptionLock — serializes every mutation of a single vendor's
 * subscription state (webhook processing, admin actions, scheduled
 * expiry) so two concurrent writers can never race past a status/plan
 * transition. A crashed holder is never permanently blocking: expiresAt is
 * a hard 10-second safety TTL that a subsequent caller's transaction
 * reclaims automatically.
 *
 * Throws LockContentionError if another holder's lock is still live. The
 * caller decides how to surface that — an HTTPS webhook returns 409
 * immediately (Paystack retries on its own schedule), a vendor/admin
 * callable throws HttpsError("aborted", ...) for the client to retry once
 * after a short delay. Neither path busy-waits or sleeps internally.
 */
export async function acquireSubscriptionLock(vendorId: string, lockedBy: string): Promise<void> {
  const lockRef = db.collection("subscriptionLocks").doc(vendorId);
  const now = Date.now();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(lockRef);
    if (snap.exists) {
      const existing = snap.data() as SubscriptionLockDoc;
      const expiresAtMs = existing.expiresAt && "toMillis" in existing.expiresAt ? existing.expiresAt.toMillis() : 0;
      if (expiresAtMs > now) {
        throw new LockContentionError(vendorId);
      }
    }
    const lock: SubscriptionLockDoc = {
      vendorId,
      lockedAt: FieldValue.serverTimestamp(),
      lockedBy,
      // A concrete future Date, not serverTimestamp() — computed and
      // committed atomically within this same transaction, so there is no
      // window where a third caller could observe an expiresAt that isn't
      // already safely in the future.
      expiresAt: Timestamp.fromMillis(now + LOCK_TTL_MS),
    };
    tx.set(lockRef, lock);
  });
}

export async function releaseSubscriptionLock(vendorId: string): Promise<void> {
  await db.collection("subscriptionLocks").doc(vendorId).delete();
}

/**
 * withSubscriptionLock — acquire, run, always release (even on error), so a
 * thrown exception inside the mutation never leaves a lock held for the
 * full 10-second TTL when it could have been released immediately.
 */
export async function withSubscriptionLock<T>(vendorId: string, lockedBy: string, fn: () => Promise<T>): Promise<T> {
  await acquireSubscriptionLock(vendorId, lockedBy);
  try {
    return await fn();
  } finally {
    await releaseSubscriptionLock(vendorId);
  }
}
