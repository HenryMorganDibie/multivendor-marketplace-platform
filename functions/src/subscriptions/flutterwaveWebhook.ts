import * as crypto from "crypto";
import { https } from "firebase-functions/v2";
import { SubscriptionPlanId } from "../types4";
import { normalizeFlutterwaveEventType } from "./eventPriority";
import { processNormalizedWebhookEvent } from "./subscriptionWebhookCore";

const VALID_PLAN_IDS: SubscriptionPlanId[] = ["basic", "standard", "pro", "pro_plus"];

function getFlutterwaveSecretHash(): string {
  // Emulator fallback mirrors the pattern used for Paystack — local
  // acceptance tests never need a real Flutterwave account.
  return process.env.FLUTTERWAVE_SECRET_HASH ?? (process.env.FUNCTIONS_EMULATOR === "true" ? "emulator_test_secret" : "");
}

/**
 * Flutterwave's webhook authentication is NOT an HMAC of the request body
 * the way Paystack's and Stripe's are. Flutterwave asks you to set a
 * static "secret hash" string in your dashboard, and every webhook it
 * sends includes that exact string back in the verif-hash header for you
 * to compare. There is nothing to compute — the comparison itself is the
 * whole check, done in constant time to avoid leaking how many leading
 * characters matched.
 */
function verifySignature(verifHashHeader: string | undefined): boolean {
  if (!verifHashHeader) return false;
  const secret = getFlutterwaveSecretHash();
  if (!secret) return false;
  const expectedBuf = Buffer.from(secret, "utf8");
  const actualBuf = Buffer.from(verifHashHeader, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * handleFlutterwaveWebhook (Provider Abstraction Contract — adding
 * Flutterwave as a fallback/alternate provider for Nigerian vendors).
 *
 * Signature verification (the verif-hash header comparison, not an HMAC)
 * happens before any Firestore access, then the payload is mapped into
 * the provider-agnostic NormalizedWebhookEvent and handed to the same
 * shared core every other provider uses — see
 * subscriptionWebhookCore.ts's header comment.
 *
 * vendorId/planId are read from Flutterwave's `meta` object (Flutterwave's
 * naming for what Paystack calls `metadata`) — set when initiating the
 * charge via createFlutterwaveCheckout.
 */
export const handleFlutterwaveWebhook = https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const verifHash = req.headers["verif-hash"] as string | undefined;
  if (!verifySignature(verifHash)) {
    res.status(401).send("Invalid signature");
    return;
  }

  const body = req.body ?? {};
  const rawEventType: string = body.event ?? "";
  const data = body.data ?? {};
  const providerEventId: string = data.id != null ? String(data.id) : data.flw_ref ?? data.tx_ref ?? "";
  const vendorId: string | null = data.meta?.vendorId ?? null;
  const eventTimestampMs: number = data.created_at ? new Date(data.created_at).getTime() : Date.now();

  if (!providerEventId) {
    res.status(400).send("Missing event id");
    return;
  }

  const { normalizedEventType } = normalizeFlutterwaveEventType(rawEventType, data.status);
  const planIdFromMeta = data.meta?.planId;

  const result = await processNormalizedWebhookEvent({
    provider: "flutterwave",
    providerEventId,
    vendorId,
    rawEventType,
    normalizedEventType,
    eventTimestampMs,
    planIdFromPayload: VALID_PLAN_IDS.includes(planIdFromMeta) ? planIdFromMeta : null,
    providerSubscriptionId: data.tx_ref || undefined,
    providerCustomerId: data.customer?.id != null ? String(data.customer.id) : undefined,
    providerPlanId: data.meta?.planCode || undefined,
    // Flutterwave amounts are already in the major currency unit (naira,
    // not kobo) — unlike Paystack/Stripe, no /100 conversion here.
    amountPaid: typeof data.amount === "number" ? data.amount : undefined,
    currency: data.currency,
  });

  res.status(result.httpStatus).send(result.message);
});
