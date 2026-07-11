import * as crypto from "crypto";
import { https } from "firebase-functions/v2";
import { SubscriptionPlanId } from "../types4";
import { normalizeStripeEventType } from "./eventPriority";
import { processNormalizedWebhookEvent } from "./subscriptionWebhookCore";

const VALID_PLAN_IDS: SubscriptionPlanId[] = ["basic", "standard", "pro", "pro_plus"];
const STRIPE_TOLERANCE_MS = 5 * 60 * 1000; // Stripe's own recommended timestamp tolerance

function getStripeWebhookSecret(): string {
  return process.env.STRIPE_WEBHOOK_SECRET ?? (process.env.FUNCTIONS_EMULATOR === "true" ? "emulator_test_secret" : "");
}

/**
 * Stripe's signature scheme (documented as `Stripe-Signature: t=<ts>,v1=<hash>`):
 * HMAC-SHA256 of `${timestamp}.${rawBody}` using the webhook signing
 * secret, plus a timestamp tolerance check to reject signatures replayed
 * long after they were generated — a second, independent layer of replay
 * protection on top of this codebase's own generic 24-hour
 * event-timestamp staleness check in subscriptionWebhookCore.ts.
 */
function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const secret = getStripeWebhookSecret();
  if (!secret) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => kv.split("=") as [string, string])
  );
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  if (Math.abs(Date.now() - Number(timestamp) * 1000) > STRIPE_TOLERANCE_MS) return false;

  const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(v1, "hex");
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * handleStripeWebhook (Provider Abstraction Contract — Stripe for
 * international vendors outside Paystack/Flutterwave's Nigeria-first
 * coverage).
 *
 * Signature verification happens before any Firestore access, then the
 * event is mapped into the provider-agnostic NormalizedWebhookEvent and
 * handed to the same shared core every other provider uses — see
 * subscriptionWebhookCore.ts's header comment.
 *
 * vendorId/planId are read from the subscription/invoice object's
 * `metadata` — set when initiating checkout via createStripeCheckout,
 * matching how Stripe Checkout Sessions are conventionally configured to
 * carry application-specific identifiers.
 */
export const handleStripeWebhook = https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const signature = req.headers["stripe-signature"] as string | undefined;
  const rawBody: Buffer = (req as unknown as { rawBody: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
  if (!verifySignature(rawBody, signature)) {
    res.status(401).send("Invalid signature");
    return;
  }

  const body = req.body ?? {};
  const rawEventType: string = body.type ?? "";
  const object = body.data?.object ?? {};
  const providerEventId: string = body.id ?? "";
  const vendorId: string | null = object.metadata?.vendorId ?? null;
  const eventTimestampMs: number = typeof body.created === "number" ? body.created * 1000 : Date.now();

  if (!providerEventId) {
    res.status(400).send("Missing event id");
    return;
  }

  const { normalizedEventType } = normalizeStripeEventType(rawEventType);
  const planIdFromMetadata = object.metadata?.planId;

  // The subscription ID lives directly on the object for
  // customer.subscription.* events, but is nested under `subscription` for
  // invoice.* events (an invoice belongs to a subscription, it isn't one).
  const providerSubscriptionId: string | undefined =
    object.object === "subscription" ? object.id : object.subscription ?? undefined;

  const result = await processNormalizedWebhookEvent({
    provider: "stripe",
    providerEventId,
    vendorId,
    rawEventType,
    normalizedEventType,
    eventTimestampMs,
    planIdFromPayload: VALID_PLAN_IDS.includes(planIdFromMetadata) ? planIdFromMetadata : null,
    providerSubscriptionId,
    providerCustomerId: object.customer || undefined,
    providerPlanId: object.items?.data?.[0]?.price?.id || undefined,
    // Stripe amounts are in the smallest currency unit (cents), same
    // convention as Paystack's kobo.
    amountPaid: typeof object.amount_paid === "number" ? object.amount_paid / 100 : undefined,
    currency: object.currency,
  });

  res.status(result.httpStatus).send(result.message);
});
