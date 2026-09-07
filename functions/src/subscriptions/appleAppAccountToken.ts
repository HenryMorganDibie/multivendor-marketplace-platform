import { https } from "firebase-functions/v2";
import * as crypto from "crypto";
import { db, FieldValue } from "../admin";
import { checkAppCheck } from "../utils/appCheck";

/**
 * Apple's StoreKit appAccountToken must be a real UUID
 * (Foundation.UUID(uuidString:) is what StoreKit parses it as) -- it cannot
 * be an arbitrary string like this app's own vendorId (a Firestore push-id
 * style string, not UUID-shaped). So a random UUID is minted once per
 * vendor and stored both ways:
 *
 *   vendors/{vendorId}.appleAppAccountToken = token   (vendor -> token,
 *     read by the mobile app before starting a purchase)
 *   appleAppAccountTokens/{token} = { vendorId }       (token -> vendor,
 *     read by appleWebhook.ts/verifyAppleTransaction.ts when Apple hands
 *     the token back on a transaction -- a direct doc read, not a query,
 *     since this runs on every subscription event)
 *
 * Idempotent: a vendor who already has a token gets the same one back
 * every time, since Apple's own records (and any purchase already made
 * with the old token) would otherwise become unreconcilable.
 */
export const getOrCreateAppleAppAccountToken = https.onCall(async (request) => {
  checkAppCheck(request, "getOrCreateAppleAppAccountToken");
  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string;

  const vendorRef = db.collection("vendors").doc(vendorId);
  const vendorSnap = await vendorRef.get();
  if (!vendorSnap.exists) {
    throw new https.HttpsError("not-found", "Vendor not found.");
  }

  const existingToken = vendorSnap.data()?.appleAppAccountToken as string | undefined;
  if (existingToken) {
    return { success: true as const, appAccountToken: existingToken };
  }

  const token = crypto.randomUUID();
  const batch = db.batch();
  batch.update(vendorRef, { appleAppAccountToken: token, updatedAt: FieldValue.serverTimestamp() });
  batch.set(db.collection("appleAppAccountTokens").doc(token), {
    vendorId,
    createdAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  return { success: true as const, appAccountToken: token };
});

/**
 * Resolves an appAccountToken back to a vendorId. A direct doc read, not a
 * collection query -- this is on the path of every Apple subscription
 * event, so it needs to be O(1) the same way every other provider's
 * webhook resolves its own vendorId directly from data already on the
 * event payload.
 */
export async function resolveVendorIdFromAppAccountToken(token: string | null | undefined): Promise<string | null> {
  if (!token) return null;
  const snap = await db.collection("appleAppAccountTokens").doc(token).get();
  return snap.exists ? ((snap.data()?.vendorId as string | undefined) ?? null) : null;
}
