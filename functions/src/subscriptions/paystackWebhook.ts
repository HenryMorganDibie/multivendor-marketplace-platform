import * as crypto from "crypto";
import { https } from "firebase-functions/v2";
import { SubscriptionPlanId } from "../types4";
import { normalizeRawEventType } from "./eventPriority";
import { processNormalizedWebhookEvent } from "./subscriptionWebhookCore";

const VALID_PLAN_IDS: SubscriptionPlanId[] = ["basic", "standard", "pro", "pro_plus"];

function getPaystackSecret(): string {
  // Emulator fallback keeps local acceptance tests self-contained without a
  // real Paystack account, matching the FUNCTIONS_EMULATOR pattern already
  // used for SMS OTP (auth/phoneOtp.ts).
  return process.env.PAYSTACK_SECRET_KEY ?? (process.env.FUNCTIONS_EMULATOR === "true" ? "emulator_test_secret" : "");
}

function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const secret = getPaystackSecret();
  if (!secret) return false;
  const expected = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  // Constant-time comparison — a naive === here would leak timing
  // information about how many leading bytes matched, letting an attacker
  // incrementally brute-force a valid signature.
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(signatureHeader, "hex");
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * handlePaystackWebhook (Phase 4, Section 5.2).
 *
 * HTTPS endpoint, not a callable — Paystack posts directly to this URL.
 * This file's only job is Paystack-specific: verify the HMAC-SHA512
 * signature before any Firestore access, then map Paystack's payload
 * shape into the provider-agnostic NormalizedWebhookEvent. Every rule
 * after that (staleness, idempotency, locking, out-of-order protection,
 * the actual mutation) lives once in subscriptionWebhookCore.ts and is
 * identical across every provider — see that file's header comment for
 * the Provider Abstraction Contract this implements.
 */
export const handlePaystackWebhook = https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const signature = req.headers["x-paystack-signature"] as string | undefined;
  const rawBody: Buffer = (req as unknown as { rawBody: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
  if (!verifySignature(rawBody, signature)) {
    res.status(401).send("Invalid signature");
    return;
  }

  const body = req.body ?? {};
  const rawEventType: string = body.event ?? "";
  const providerEventId: string = body.data?.id != null ? String(body.data.id) : (req.headers["x-paystack-request-id"] as string) ?? "";
  const vendorId: string | null = body.data?.metadata?.vendorId ?? null;
  const eventTimestampMs: number = body.data?.created_at ? new Date(body.data.created_at).getTime() : Date.now();

  if (!providerEventId) {
    res.status(400).send("Missing event id");
    return;
  }

  const { normalizedEventType } = normalizeRawEventType(rawEventType);
  const planIdFromMetadata = body.data?.plan?.plan_code_metadata?.planId;

  const result = await processNormalizedWebhookEvent({
    provider: "paystack",
    providerEventId,
    vendorId,
    rawEventType,
    normalizedEventType,
    eventTimestampMs,
    planIdFromPayload: VALID_PLAN_IDS.includes(planIdFromMetadata) ? planIdFromMetadata : null,
    providerSubscriptionId: body.data?.subscription_code || undefined,
    providerCustomerId: body.data?.customer?.customer_code || undefined,
    providerPlanId: body.data?.plan?.plan_code || undefined,
    amountPaid: typeof body.data?.amount === "number" ? body.data.amount / 100 : undefined,
    currency: body.data?.currency,
  });

  res.status(result.httpStatus).send(result.message);
});
