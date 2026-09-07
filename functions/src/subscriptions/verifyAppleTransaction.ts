import { https, logger } from "firebase-functions/v2";
import { SubscriptionPlanId } from "../types4";
import { normalizeAppleEventType } from "./eventPriority";
import { processNormalizedWebhookEvent } from "./subscriptionWebhookCore";
import { getAppStoreServerClient, verifyAndDecodeTransaction, PRODUCT_ID_TO_PLAN } from "./appleServerApi";
import { resolveVendorIdFromAppAccountToken } from "./appleAppAccountToken";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";

/**
 * verifyAppleTransaction -- called by the mobile app immediately after
 * react-native-iap reports a completed purchase, so the vendor sees their
 * plan change right away instead of waiting on Apple's asynchronous
 * server notification (which usually lands within seconds, but "usually"
 * is not what a purchase confirmation screen should depend on).
 *
 * Deliberately does NOT trust anything the client sends about the purchase
 * itself -- only the transactionId, used to fetch the transaction directly
 * from Apple's own server (getTransactionInfo), the same signed JWS
 * handleAppleWebhook would eventually receive. Verified and processed
 * through the exact same processNormalizedWebhookEvent core, so a client
 * calling this twice, or Apple's webhook also arriving for the same
 * transaction, is exactly the idempotency case that function already
 * handles -- this is not a second, parallel source of truth.
 */
export const verifyAppleTransaction = https.onCall(
  { secrets: ["APPLE_IAP_PRIVATE_KEY"] },
  async (request) => {
    const requestId = newRequestId();
    const appCheck = checkAppCheck(request, "verifyAppleTransaction");
    if (!request.auth || request.auth.token.role !== "vendor") {
      throw new https.HttpsError("permission-denied", "Vendors only.");
    }
    const callerVendorId = request.auth.token.vendorId as string;
    const { transactionId } = request.data ?? {};
    if (!transactionId || typeof transactionId !== "string") {
      throw new https.HttpsError("invalid-argument", "transactionId is required.");
    }

    let signedTransactionInfo: string | undefined;
    try {
      const client = getAppStoreServerClient();
      const response = await client.getTransactionInfo(transactionId);
      signedTransactionInfo = response.signedTransactionInfo;
    } catch (err) {
      logger.error("[verifyAppleTransaction] getTransactionInfo failed", { error: String(err), transactionId });
      throw new https.HttpsError("not-found", "Could not retrieve this transaction from Apple.");
    }

    if (!signedTransactionInfo) {
      throw new https.HttpsError("not-found", "Apple returned no transaction data.");
    }

    let transaction;
    try {
      transaction = await verifyAndDecodeTransaction(signedTransactionInfo);
    } catch (err) {
      logger.warn("[verifyAppleTransaction] Signature verification failed", { error: String(err) });
      throw new https.HttpsError("invalid-argument", "Invalid transaction signature.");
    }

    const resolvedVendorId = await resolveVendorIdFromAppAccountToken(transaction.appAccountToken);

    // The caller can only ever confirm their OWN purchase -- Apple's
    // appAccountToken -> vendorId resolution is the source of truth for
    // whose subscription this is, and it must agree with who is asking.
    // A mismatch here means either a stale/reused token or a transactionId
    // that belongs to a different vendor entirely; neither should ever
    // silently activate someone else's subscription.
    if (resolvedVendorId !== callerVendorId) {
      logger.error("[verifyAppleTransaction] vendorId mismatch", {
        callerVendorId, resolvedVendorId, transactionId,
      });
      throw new https.HttpsError("permission-denied", "This transaction does not belong to your account.");
    }

    const productId = transaction.productId ?? "";
    const planIdFromPayload: SubscriptionPlanId | null = PRODUCT_ID_TO_PLAN[productId] ?? null;

    // A freshly completed purchase is always the App Store Server
    // Notifications V2 "SUBSCRIBED" activation shape from
    // processNormalizedWebhookEvent's point of view, regardless of which
    // notification type Apple eventually also sends for the same
    // transaction -- this call exists specifically to get ahead of that.
    const { normalizedEventType } = normalizeAppleEventType("SUBSCRIBED", undefined);

    const result = await processNormalizedWebhookEvent({
      provider: "apple",
      providerEventId: transaction.transactionId ?? transactionId,
      vendorId: resolvedVendorId,
      rawEventType: "SUBSCRIBED",
      normalizedEventType,
      eventTimestampMs: transaction.purchaseDate ?? Date.now(),
      planIdFromPayload,
      providerSubscriptionId: transaction.originalTransactionId,
      providerPlanId: productId || undefined,
    });

    if (result.httpStatus >= 400) {
      throw new https.HttpsError("internal", result.message);
    }

    await writeAuditLog({
      requestId,
      functionName: "verifyAppleTransaction",
      actorUid: request.auth.uid,
      actorRole: "vendor",
      actorType: "vendor",
      targetType: "vendor",
      targetId: callerVendorId,
      eventType: "subscription.apple_transaction_verified",
      after: { plan: planIdFromPayload, transactionId },
      appCheck,
    });

    return { success: true as const, plan: planIdFromPayload };
  }
);
