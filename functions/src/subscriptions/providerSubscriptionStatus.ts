import { SubscriptionProvider } from "../types4";

/**
 * verifyProviderSubscriptionActive — the provider-side re-verification
 * required by PHASE_4_COLLECTION_MAPPING v10 Section 4.1 ("Late payment
 * after expiry resolution") before restoring a subscription that has
 * already been marked `expired` by expireStaleSubscriptions. Used
 * exclusively from that one recovery path in subscriptionWebhookCore.ts —
 * this is deliberately NOT a general "check the provider before every
 * plan decision" mechanism, which would violate the architectural
 * guarantee that Firestore is the sole source of truth for ordinary
 * authorization. It exists only to distinguish two situations that look
 * identical from a bare webhook payload: a late-arriving webhook for a
 * payment that cleared before the subscription actually lapsed (restore),
 * versus a payment on a subscription that was independently cancelled on
 * the provider's side (do not restore).
 *
 * Each provider branch uses that provider's standard, documented
 * subscription-fetch endpoint with the same Authorization pattern already
 * established in internationalCheckout.ts's cancelProviderSubscription.
 * Only the Paystack path has been exercised in this codebase before
 * (via cancelProviderSubscription's /subscription/disable call); the
 * Flutterwave and Stripe branches follow their standard documented GET
 * shapes but, like cancelProviderSubscription's own note for those two
 * providers, have not been verified against a live sandbox — verify
 * before this path is exercised in production for a non-Paystack vendor.
 *
 * Returns true if the provider confirms the subscription is still in an
 * active state, false if the provider says otherwise (cancelled, not
 * found, or any non-active status), or if the check cannot be performed
 * at all (missing id, missing secret, network/parse failure). false is
 * the safe default: this function's only caller treats false as "do not
 * restore," never as "restore anyway," matching the spec's "do not
 * silently restore" requirement.
 */
export async function verifyProviderSubscriptionActive(
  provider: SubscriptionProvider,
  providerSubscriptionId: string | undefined | null
): Promise<boolean> {
  if (!providerSubscriptionId) return false;

  // Emulator/local acceptance tests have no real provider to call — mirrors
  // the FUNCTIONS_EMULATOR fallback already used by cancelProviderSubscription
  // and the Paystack signature check, so existing emulator-based subscription
  // tests keep exercising the restore path exactly as before.
  if (process.env.FUNCTIONS_EMULATOR === "true") return true;

  try {
    if (provider === "paystack") {
      const secret = process.env.PAYSTACK_SECRET_KEY ?? "";
      if (!secret) return false;
      const resp = await fetch(`https://api.paystack.co/subscription/${encodeURIComponent(providerSubscriptionId)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${secret}` },
      });
      if (!resp.ok) return false;
      const json = (await resp.json()) as { data?: { status?: string } };
      // Paystack subscription statuses: active, non-renewing, attention,
      // completed, cancelled. "non-renewing" still means the current period
      // is paid and live (it just won't renew again) so it counts as active
      // for the purpose of "did this payment land on a subscription that was
      // genuinely still running." Only "active" and "non-renewing" pass.
      const status = json.data?.status;
      return status === "active" || status === "non-renewing";
    }

    if (provider === "flutterwave") {
      const secret = process.env.FLUTTERWAVE_SECRET_KEY ?? "";
      if (!secret) return false;
      const resp = await fetch(`https://api.flutterwave.com/v3/subscriptions/${encodeURIComponent(providerSubscriptionId)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${secret}` },
      });
      if (!resp.ok) return false;
      const json = (await resp.json()) as { data?: { status?: string } };
      return json.data?.status === "active";
    }

    if (provider === "stripe") {
      const secret = process.env.STRIPE_SECRET_KEY ?? "";
      if (!secret) return false;
      const resp = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(providerSubscriptionId)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${secret}` },
      });
      if (!resp.ok) return false;
      const json = (await resp.json()) as { status?: string };
      return json.status === "active" || json.status === "trialing";
    }

    // manual_admin_override or any future provider not yet given an adapter
    // here: cannot verify, so do not restore automatically. Admin-driven
    // recovery goes through applyManualSubscriptionOverride, not this path.
    return false;
  } catch {
    // Network/parse failure — cannot confirm, so do not restore. The vendor
    // is not left worse off than before this check existed: they still see
    // the ignored-event trail and can be restored explicitly by an admin,
    // or their next genuinely new webhook retry will re-attempt this check.
    return false;
  }
}
