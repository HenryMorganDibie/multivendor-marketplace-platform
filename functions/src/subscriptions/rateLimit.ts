import { https } from "firebase-functions/v2";
import { db, Timestamp } from "../admin";
import { RateLimitDoc } from "../types4";

const WINDOW_MS = 60_000;

/**
 * enforceRateLimit — fixed-window limiter for billing-sensitive callables
 * (Phase 4 v6). Scoped per vendor per function, so one vendor hammering
 * one callable never affects another vendor, and calling a different
 * rate-limited function in the same window is unaffected too.
 *
 * Throws HttpsError("resource-exhausted", ...) once the window's count is
 * exceeded. The window resets by simply starting a new one once
 * WINDOW_MS has elapsed since windowStart — no cleanup job needed, stale
 * windows are just overwritten on next use.
 */
export async function enforceRateLimit(vendorId: string, functionName: string, maxRequests = 5): Promise<void> {
  const docId = `${vendorId}_${functionName}`;
  const ref = db.collection("rateLimits").doc(docId);
  const now = Date.now();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      const doc: RateLimitDoc = { vendorId, functionName, windowStart: Timestamp.fromMillis(now), requestCount: 1 };
      tx.set(ref, doc);
      return;
    }

    const data = snap.data() as RateLimitDoc;
    const windowStartMs = data.windowStart && "toMillis" in data.windowStart ? data.windowStart.toMillis() : 0;

    if (now - windowStartMs > WINDOW_MS) {
      // Window elapsed — start a fresh one.
      const doc: RateLimitDoc = { vendorId, functionName, windowStart: Timestamp.fromMillis(now), requestCount: 1 };
      tx.set(ref, doc);
      return;
    }

    if (data.requestCount >= maxRequests) {
      throw new https.HttpsError("resource-exhausted", `Too many requests to ${functionName}. Try again shortly.`);
    }

    tx.update(ref, { requestCount: data.requestCount + 1 });
  });
}
