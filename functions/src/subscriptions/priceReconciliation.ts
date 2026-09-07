import { logger } from "firebase-functions/v2";
import { db, FieldValue, Timestamp } from "../admin";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";

/**
 * Checks what a provider actually charged against what was approved.
 *
 * The provider is the billing authority. A subscription lives on Paystack,
 * Flutterwave or Stripe, attached to a plan defined there, and that plan is what
 * charges the card. `pricing.json` is what the platform approved and displays.
 *
 * Nothing forces those two to agree. Update a country's price without creating
 * and mapping a new provider-side plan and the two silently diverge: the app
 * shows the new amount, the provider keeps charging the old one, and nobody
 * finds out until somebody reconciles a statement by hand.
 *
 * Verifying the mapping ahead of time needs the provider APIs and real
 * credentials, which is the proper fix and is not possible from here yet. This
 * is the detective half: every activation and renewal already reports what was
 * charged, so comparing that against the approved price costs one read and
 * turns a silent, indefinite discrepancy into a flagged record within minutes
 * of the first wrong charge.
 *
 * It deliberately does not block or reverse anything. The money has already
 * moved by the time a webhook arrives, and refusing to record a payment that
 * genuinely happened would leave the subscription in a worse state than the
 * mismatch does.
 */

export interface ChargeReconciliationInput {
  vendorId: string;
  plan: string;
  /** What the provider actually took, in minor units. */
  chargedMinorUnits: number;
  chargedCurrency: string;
  provider: string;
  providerPlanId?: string | null;
}

export async function reconcileChargeAgainstApprovedPrice(
  input: ChargeReconciliationInput
): Promise<void> {
  const { vendorId, plan, chargedMinorUnits, chargedCurrency, provider } = input;

  try {
    // Resolved here rather than passed in. The webhook does its work inside a
    // transaction, and this runs after it, so the read belongs on this side
    // instead of being threaded through.
    const vendorSnap = await db.collection("vendors").doc(vendorId).get();
    const countryCode = vendorSnap.data()?.countryCode as string | undefined;

    // No country means nothing to compare against. That is a separate data
    // problem, not a pricing mismatch, and inventing a comparison would only
    // produce a false alarm.
    if (!countryCode) return;

    const pricingSnap = await db.collection("subscriptionPricing").doc(countryCode).get();
    if (!pricingSnap.exists) {
      // A charge for a country with no approved price at all is worth knowing
      // about: somebody is paying for a plan the platform never published there.
      await flag({
        ...input,
        countryCode,
        reason: "NO_APPROVED_PRICE",
        expectedMinorUnits: null,
        expectedCurrency: null,
      });
      return;
    }

    const pricing = pricingSnap.data() ?? {};
    const expectedMinorUnits = pricing.plans?.[plan]?.monthlyPriceMinorUnits as number | undefined;
    const expectedCurrency = pricing.currencyCode as string | undefined;

    if (typeof expectedMinorUnits !== "number" || !expectedCurrency) return;

    const amountMatches = expectedMinorUnits === chargedMinorUnits;
    // Currency is compared case-insensitively: providers are inconsistent about
    // it and "ngn" versus "NGN" is not a discrepancy worth waking anyone for.
    const currencyMatches =
      expectedCurrency.toUpperCase() === (chargedCurrency ?? "").toUpperCase();

    if (amountMatches && currencyMatches) return;

    await flag({
      ...input,
      countryCode,
      reason: currencyMatches ? "AMOUNT_MISMATCH" : "CURRENCY_MISMATCH",
      expectedMinorUnits,
      expectedCurrency,
    });
  } catch (err) {
    // A failure here must never affect the subscription. The payment is real
    // and recording it matters more than checking it.
    logger.error("Price reconciliation could not run.", { vendorId, provider, err });
  }
}

async function flag(
  input: ChargeReconciliationInput & {
    countryCode: string;
    reason: "AMOUNT_MISMATCH" | "CURRENCY_MISMATCH" | "NO_APPROVED_PRICE";
    expectedMinorUnits: number | null;
    expectedCurrency: string | null;
  }
): Promise<void> {
  const requestId = newRequestId();

  // One document per vendor and plan rather than one per renewal: a stale
  // mapping charges the wrong amount every month, and a hundred identical
  // records would bury the twenty distinct problems underneath them.
  const id = `${input.vendorId}_${input.plan}`;
  const ref = db.collection("pricingDiscrepancies").doc(id);

  /**
   * firstSeenAt and resolved are written only when the document is created.
   *
   * They were previously in the payload below with merge: true, and a comment
   * claiming firstSeenAt would survive. Merge only preserves fields the payload
   * omits — one it names is overwritten like any other. So firstSeenAt moved
   * forward on every occurrence and always equalled lastSeenAt, which destroys
   * the only thing it exists to answer: how long this has been going wrong.
   *
   * resolved was worse. Rewriting it as false on every occurrence silently
   * reopened a discrepancy an admin had already dealt with, so the same
   * finished item kept reappearing with no indication of why.
   */
  const existing = await ref.get();
  const firstWrite = !existing.exists
    ? { firstSeenAt: Timestamp.now(), resolved: false }
    : {};

  await ref.set(
    {
      ...firstWrite,
      vendorId: input.vendorId,
      plan: input.plan,
      countryCode: input.countryCode ?? null,
      provider: input.provider,
      providerPlanId: input.providerPlanId ?? null,
      reason: input.reason,
      chargedMinorUnits: input.chargedMinorUnits,
      chargedCurrency: input.chargedCurrency,
      expectedMinorUnits: input.expectedMinorUnits,
      expectedCurrency: input.expectedCurrency,
      differenceMinorUnits:
        input.expectedMinorUnits === null
          ? null
          : input.chargedMinorUnits - input.expectedMinorUnits,
      occurrences: FieldValue.increment(1),
      lastSeenAt: Timestamp.now(),
    },
    // merge so occurrences accumulate and the fields set only on creation
    // above are left alone.
    { merge: true }
  );

  logger.error("A provider charged an amount that does not match the approved price.", {
    vendorId: input.vendorId,
    plan: input.plan,
    countryCode: input.countryCode,
    provider: input.provider,
    reason: input.reason,
    charged: `${input.chargedMinorUnits} ${input.chargedCurrency}`,
    expected:
      input.expectedMinorUnits === null
        ? "no approved price"
        : `${input.expectedMinorUnits} ${input.expectedCurrency}`,
  });

  await writeAuditLog({
    requestId,
    functionName: "reconcileChargeAgainstApprovedPrice",
    actorUid: "system",
    actorRole: "admin",
    actorType: "system",
    targetType: "vendor",
    targetId: input.vendorId,
    eventType: "subscription.price_mismatch",
    message:
      input.reason === "NO_APPROVED_PRICE"
        ? `${input.provider} charged for ${input.plan} in ${input.countryCode} where no approved price exists.`
        : `${input.provider} charged ${input.chargedMinorUnits} ${input.chargedCurrency} for ${input.plan}, approved price is ${input.expectedMinorUnits} ${input.expectedCurrency}.`,
    appCheck: { present: false, verified: null },
  });
}
