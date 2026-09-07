import { https } from "firebase-functions/v2";
import { db, Timestamp } from "../admin";
import { RateLimitDoc } from "../types4";

const WINDOW_MS = 60_000;

/**
 * enforceRateLimit — fixed-window limiter for billing-sensitive callables.
 *
 * Scoped per caller per function, so one caller hammering one callable never
 * affects anybody else, and their other calls are unaffected too.
 *
 * The key was originally a vendorId, hence the field name on the stored
 * document. It is now any stable caller identity: a uid for a signed-in user,
 * or `ip:<address>` for an unauthenticated one, so a limit cannot be sidestepped
 * by simply not signing in.
 *
 * Authentication on its own does not prevent abuse. A signed-in user can call a
 * write endpoint in a loop, and both Firestore writes and function invocations
 * bill per call, so any callable that writes needs a ceiling regardless of who
 * is calling it.
 *
 * Throws HttpsError("resource-exhausted", ...) once the window's count is
 * exceeded. The window resets by simply starting a new one once
 * WINDOW_MS has elapsed since windowStart — no cleanup job needed, stale
 * windows are just overwritten on next use.
 */
export async function enforceRateLimit(callerKey: string, functionName: string, maxRequests = 5): Promise<void> {
  // Slashes and dots appear in IP-based keys and would split the document path.
  const safeKey = callerKey.replace(/[/.]/g, "_");
  const docId = `${safeKey}_${functionName}`;
  const ref = db.collection("rateLimits").doc(docId);
  const now = Date.now();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      const doc: RateLimitDoc = { vendorId: callerKey, functionName, windowStart: Timestamp.fromMillis(now), requestCount: 1 };
      tx.set(ref, doc);
      return;
    }

    const data = snap.data() as RateLimitDoc;
    const windowStartMs = data.windowStart && "toMillis" in data.windowStart ? data.windowStart.toMillis() : 0;

    if (now - windowStartMs > WINDOW_MS) {
      // Window elapsed — start a fresh one.
      const doc: RateLimitDoc = { vendorId: callerKey, functionName, windowStart: Timestamp.fromMillis(now), requestCount: 1 };
      tx.set(ref, doc);
      return;
    }

    if (data.requestCount >= maxRequests) {
      throw new https.HttpsError("resource-exhausted", `Too many requests to ${functionName}. Try again shortly.`);
    }

    tx.update(ref, { requestCount: data.requestCount + 1 });
  });
}
