import { https, logger } from "firebase-functions/v2";
import { SubscriptionPlanId } from "../types4";
import { GOOGLE_NOTIFICATION_TYPE, normalizeGoogleEventType } from "./eventPriority";
import { processNormalizedWebhookEvent } from "./subscriptionWebhookCore";
import { getSubscriptionPurchaseV2, GOOGLE_PRODUCT_ID_TO_PLAN } from "./googleServerApi";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";

/**
 * verifyGoogleTransaction -- the Google Play counterpart to
 * verifyAppleTransaction.ts. Called by the mobile app immediately after a
 * Play Billing purchase completes, so the vendor sees their plan change
 * right away instead of waiting on RTDN (which usually lands within
 * seconds, but should not be what a purchase confirmation screen depends
 * on).
 *
 * Same trust model as the Apple version: does not trust anything the
 * client claims about the purchase beyond the purchaseToken, used to fetch
 * the purchase directly from Google's own API. Processed through the exact
 * same core handleGoogleWebhook uses -- not a second, parallel source of
 * truth, and a client calling this twice (or RTDN also arriving for the
 * same purchase) is the ordinary idempotency case that core already
 * handles via Pub/Sub's messageId there / this call's own purchaseToken
 * here as the dedup key.
 */
export const verifyGoogleTransaction = https.onCall(
  { secrets: ["GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"] },
  async (request) => {
    const requestId = newRequestId();
    const appCheck = checkAppCheck(request, "verifyGoogleTransaction");
    if (!request.auth || request.auth.token.role !== "vendor") {
      throw new https.HttpsError("permission-denied", "Vendors only.");
    }
    const callerVendorId = request.auth.token.vendorId as string;
    const { purchaseToken } = request.data ?? {};
    if (!purchaseToken || typeof purchaseToken !== "string") {
      throw new https.HttpsError("invalid-argument", "purchaseToken is required.");
    }

    let purchase;
    try {
      purchase = await getSubscriptionPurchaseV2(purchaseToken);
    } catch (err) {
      logger.error("[verifyGoogleTransaction] getSubscriptionPurchaseV2 failed", { error: String(err) });
      throw new https.HttpsError("not-found", "Could not retrieve this purchase from Google.");
    }

    const resolvedVendorId = purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null;

    // Same guard as verifyAppleTransaction: the caller can only ever
    // confirm their own purchase. A mismatch means either a stale/reused
    // token or a purchaseToken belonging to a different vendor entirely.
    if (resolvedVendorId !== callerVendorId) {
      logger.error("[verifyGoogleTransaction] vendorId mismatch", {
        callerVendorId, resolvedVendorId,
      });
      throw new https.HttpsError("permission-denied", "This purchase does not belong to your account.");
    }

    const productId = purchase.lineItems?.[0]?.productId ?? "";
    const planIdFromPayload: SubscriptionPlanId | null = GOOGLE_PRODUCT_ID_TO_PLAN[productId] ?? null;

    // A freshly completed purchase is always the RTDN SUBSCRIPTION_PURCHASED
    // shape from processNormalizedWebhookEvent's point of view, regardless
    // of which notification Google eventually also sends for the same
    // purchase -- this call exists specifically to get ahead of that.
    const { normalizedEventType } = normalizeGoogleEventType(GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_PURCHASED);

    const result = await processNormalizedWebhookEvent({
      provider: "google",
      providerEventId: `verify:${purchaseToken}`,
      vendorId: resolvedVendorId,
      rawEventType: String(GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_PURCHASED),
      normalizedEventType,
      eventTimestampMs: purchase.startTime ? new Date(purchase.startTime).getTime() : Date.now(),
      planIdFromPayload,
      providerSubscriptionId: purchase.linkedPurchaseToken ?? purchaseToken,
      providerPlanId: productId || undefined,
    });

    if (result.httpStatus >= 400) {
      throw new https.HttpsError("internal", result.message);
    }

    await writeAuditLog({
      requestId,
      functionName: "verifyGoogleTransaction",
      actorUid: request.auth.uid,
      actorRole: "vendor",
      actorType: "vendor",
      targetType: "vendor",
      targetId: callerVendorId,
      eventType: "subscription.google_transaction_verified",
      after: { plan: planIdFromPayload, purchaseToken },
      appCheck,
    });

    return { success: true as const, plan: planIdFromPayload };
  }
);
