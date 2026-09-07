import { https, logger } from "firebase-functions/v2";
import { SubscriptionPlanId } from "../types4";
import { normalizeAppleEventType } from "./eventPriority";
import { processNormalizedWebhookEvent } from "./subscriptionWebhookCore";
import { verifyAndDecodeNotification, verifyAndDecodeTransaction, PRODUCT_ID_TO_PLAN } from "./appleServerApi";
import { resolveVendorIdFromAppAccountToken } from "./appleAppAccountToken";

/**
 * handleAppleWebhook (Provider Abstraction Contract -- Apple App Store
 * Server Notifications V2).
 *
 * Apple's whole payload is a single signed JWS string (`signedPayload` in
 * the POST body) rather than a separate header + raw body the way Stripe/
 * Flutterwave/Paystack sign theirs. verifyAndDecodeNotification checks that
 * signature chain back to Apple's own root certificate -- that check IS
 * this handler's equivalent of the other providers' HMAC/webhook-secret
 * verification, and must happen before any of the decoded fields are
 * trusted.
 *
 * The notification's outer envelope names the event type and carries a
 * nested signedTransactionInfo, itself a second signed JWS that has to be
 * separately verified and decoded to get the actual productId/
 * appAccountToken/transactionId. There is no metadata field the way
 * Stripe/Paystack checkout sessions carry vendorId/planId directly --
 * appAccountToken is Apple's mechanism for the app to attach its own
 * identifier to a purchase. It has to be a real UUID (StoreKit requirement),
 * not the vendorId itself, so getOrCreateAppleAppAccountToken mints one per
 * vendor and appleAppAccountToken.ts's resolveVendorIdFromAppAccountToken
 * reverses it back to a vendorId here.
 *
 * Sandbox/production are no longer this handler's concern -- see
 * verifyAndDecodeNotification's own header comment in appleServerApi.ts for
 * how a single deployment now verifies against whichever of the two
 * environments a given payload actually turns out to be from.
 *
 * Verified end-to-end against Apple's real sandbox test-notification flow
 * (requestTestNotification -> this function -> 200, signature verified).
 * That test only exercises signature verification, not this vendorId
 * resolution -- Apple's own TEST notifications carry no transaction/
 * appAccountToken at all (see the no-signedTransactionInfo branch below), so
 * this specific path is only provable by an actual purchase.
 */
export const handleAppleWebhook = https.onRequest(
  { secrets: ["APPLE_IAP_PRIVATE_KEY"] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    const signedPayload: string | undefined = req.body?.signedPayload;
    if (!signedPayload) {
      res.status(400).send("Missing signedPayload");
      return;
    }

    let notification;
    try {
      notification = await verifyAndDecodeNotification(signedPayload);
    } catch (err) {
      logger.warn("[appleWebhook] Signature verification failed", { error: String(err) });
      res.status(401).send("Invalid signature");
      return;
    }

    const rawEventType = notification.notificationType ?? "";
    const subtype = notification.subtype;
    const signedTransactionInfo = notification.data?.signedTransactionInfo;

    if (!signedTransactionInfo) {
      // Some notification types (e.g. REFUND_REVERSED without a
      // transaction, CONSUMPTION_REQUEST) carry no transaction to attach
      // this to. Acknowledged so Apple doesn't retry, but nothing to
      // process -- matches the other providers' "ignored" path.
      res.status(200).send("No transaction info; ignored");
      return;
    }

    let transaction;
    try {
      transaction = await verifyAndDecodeTransaction(signedTransactionInfo);
    } catch (err) {
      logger.warn("[appleWebhook] Transaction signature verification failed", { error: String(err) });
      res.status(401).send("Invalid transaction signature");
      return;
    }

    const providerEventId = transaction.transactionId ?? "";
    if (!providerEventId) {
      res.status(400).send("Missing transaction id");
      return;
    }

    // appAccountToken is a random UUID minted per-vendor by
    // getOrCreateAppleAppAccountToken, NOT the vendorId itself -- Apple's
    // StoreKit requires this field to be a real UUID, which vendorId (a
    // Firestore push-id string) is not. resolveVendorIdFromAppAccountToken
    // reverses the mapping this same UUID was created under.
    const vendorId = await resolveVendorIdFromAppAccountToken(transaction.appAccountToken);

    const productId = transaction.productId ?? "";
    const planIdFromPayload: SubscriptionPlanId | null = PRODUCT_ID_TO_PLAN[productId] ?? null;

    const { normalizedEventType } = normalizeAppleEventType(rawEventType, subtype);

    const result = await processNormalizedWebhookEvent({
      provider: "apple",
      providerEventId,
      vendorId,
      rawEventType,
      normalizedEventType,
      eventTimestampMs: notification.signedDate ?? Date.now(),
      planIdFromPayload,
      providerSubscriptionId: transaction.originalTransactionId,
      providerPlanId: productId || undefined,
      // Apple does not include price/currency on the transaction payload
      // itself -- App Store Server Notifications are not billing receipts.
      // amountPaid/currency stay undefined here, same as any provider event
      // that carries no charge amount.
    });

    res.status(result.httpStatus).send(result.message);
  }
);
