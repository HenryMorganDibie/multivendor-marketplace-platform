import { https, logger } from "firebase-functions/v2";
import { OAuth2Client } from "google-auth-library";
import { SubscriptionPlanId } from "../types4";
import { normalizeGoogleEventType } from "./eventPriority";
import { processNormalizedWebhookEvent } from "./subscriptionWebhookCore";
import { getSubscriptionPurchaseV2, GOOGLE_PRODUCT_ID_TO_PLAN } from "./googleServerApi";

/**
 * handleGoogleWebhook (Provider Abstraction Contract -- Google Play
 * Real-time Developer Notifications).
 *
 * Google delivers RTDN via a Pub/Sub push subscription: this endpoint's
 * own URL is the Pub/Sub push endpoint, and Pub/Sub itself signs every
 * push request with a JWT in the Authorization header
 * (https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions)
 * -- that JWT verification IS this handler's equivalent of Stripe's HMAC
 * check / Apple's JWS chain, and must happen before the payload is
 * trusted. The audience claim must match this function's own URL, set via
 * GOOGLE_PUBSUB_PUSH_AUDIENCE once the Pub/Sub subscription is created
 * (SCAFFOLD: not created yet, no real audience value exists).
 *
 * The RTDN payload itself (base64 JSON in message.data) carries only
 * packageName/subscriptionId(productId)/purchaseToken/notificationType --
 * never the vendor's identity or current plan state, so
 * getSubscriptionPurchaseV2 makes a real API call to fetch the full
 * purchase record, the same shape of extra round-trip
 * verifyAndDecodeTransaction does for Apple's nested JWS.
 *
 * SCAFFOLD: cannot be exercised end-to-end until:
 *  - GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is real (Play Console service
 *    account with the Play Developer API enabled, not created yet)
 *  - GOOGLE_PRODUCT_ID_TO_PLAN has real entries (subscription products
 *    not created in Play Console yet)
 *  - a Pub/Sub topic + push subscription pointing at this function's URL
 *    exists, and GOOGLE_PUBSUB_PUSH_AUDIENCE is set to match
 *  - the mobile purchase flow passes obfuscatedAccountId = vendorId
 *    (Google, unlike Apple, has no UUID-format requirement here -- the raw
 *    vendorId can be used directly, no token-minting/reverse-lookup
 *    collection needed the way appleAppAccountToken.ts provides)
 */
export const handleGoogleWebhook = https.onRequest(
  { secrets: ["GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    const authHeader = req.headers.authorization;
    const audience = process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE;
    if (!authHeader || !audience) {
      res.status(401).send("Missing authorization or unconfigured audience");
      return;
    }
    try {
      const client = new OAuth2Client();
      const token = authHeader.replace(/^Bearer /, "");
      await client.verifyIdToken({ idToken: token, audience });
    } catch (err) {
      logger.warn("[googleWebhook] Pub/Sub push token verification failed", { error: String(err) });
      res.status(401).send("Invalid Pub/Sub push token");
      return;
    }

    let payload: {
      packageName?: string;
      eventTimeMillis?: string;
      subscriptionNotification?: { notificationType?: number; purchaseToken?: string; subscriptionId?: string };
      testNotification?: unknown;
    };
    let pubsubMessageId: string | undefined;
    try {
      const dataB64: string | undefined = req.body?.message?.data;
      pubsubMessageId = req.body?.message?.messageId;
      if (!dataB64) throw new Error("missing message.data");
      payload = JSON.parse(Buffer.from(dataB64, "base64").toString("utf8"));
    } catch (err) {
      logger.error("[googleWebhook] Could not decode Pub/Sub message", { error: String(err) });
      res.status(400).send("Malformed Pub/Sub message");
      return;
    }

    if (payload.testNotification || !payload.subscriptionNotification) {
      // Google's own "Send test notification" button, or a notification
      // type this integration doesn't handle (one-time products, base
      // plan changes not affecting entitlement) -- acknowledged so Pub/Sub
      // doesn't retry, matching every other provider's "ignored" path.
      res.status(200).send("No subscription notification; ignored");
      return;
    }

    const { notificationType, purchaseToken, subscriptionId } = payload.subscriptionNotification;
    if (!purchaseToken || typeof notificationType !== "number") {
      res.status(400).send("Missing purchaseToken or notificationType");
      return;
    }

    let purchase;
    try {
      purchase = await getSubscriptionPurchaseV2(purchaseToken);
    } catch (err) {
      logger.error("[googleWebhook] getSubscriptionPurchaseV2 failed", { error: String(err), purchaseToken });
      res.status(500).send("Could not retrieve subscription details from Google");
      return;
    }

    const vendorId: string | null = purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null;
    const productId = purchase.lineItems?.[0]?.productId ?? subscriptionId ?? "";
    const planIdFromPayload: SubscriptionPlanId | null = GOOGLE_PRODUCT_ID_TO_PLAN[productId] ?? null;
    const { normalizedEventType } = normalizeGoogleEventType(notificationType);

    // linkedPurchaseToken is Google's closest analogue to Apple's
    // originalTransactionId -- points at the prior token when this
    // purchase is a resubscribe/upgrade/downgrade continuation. Falls back
    // to this purchase's own token when there is no prior one, same as
    // any first-time subscription.
    const providerSubscriptionId = purchase.linkedPurchaseToken ?? purchaseToken;

    if (!pubsubMessageId) {
      res.status(400).send("Missing Pub/Sub messageId");
      return;
    }

    const result = await processNormalizedWebhookEvent({
      provider: "google",
      // Pub/Sub's own per-delivery messageId, not purchaseToken -- the
      // token stays the same across an entire subscription's renewals, so
      // a composite of token+notificationType would make every renewal
      // after the first look like a duplicate of it and get silently
      // dropped by the idempotency check in subscriptionWebhookCore.ts.
      providerEventId: pubsubMessageId,
      vendorId,
      rawEventType: String(notificationType),
      normalizedEventType,
      eventTimestampMs: payload.eventTimeMillis ? Number(payload.eventTimeMillis) : Date.now(),
      planIdFromPayload,
      providerSubscriptionId,
      providerPlanId: productId || undefined,
      // Google's RTDN/subscriptionsv2 response carries no charge amount
      // either -- same as Apple, amountPaid/currency stay undefined.
    });

    res.status(result.httpStatus).send(result.message);
  }
);
