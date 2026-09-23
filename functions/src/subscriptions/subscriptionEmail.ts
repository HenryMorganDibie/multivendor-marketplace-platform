import { db } from "../admin";
import { logOperationalEvent } from "../utils/operationalLogging";

/**
 * Resolves the email address to notify for a vendor's subscription
 * lifecycle events, via vendors/{vendorId}.ownerUid -> users/{uid}.email.
 * Shared by every subscription mutation path (webhook core, vendor
 * callables, admin callables, scheduled jobs) so there is exactly one
 * place that knows how a vendorId maps to a notifiable email address.
 */
export async function getVendorEmail(vendorId: string): Promise<string | null> {
  const vendorSnap = await db.collection("vendors").doc(vendorId).get();
  const ownerUid = vendorSnap.data()?.ownerUid as string | undefined;
  if (!ownerUid) return null;
  const userSnap = await db.collection("users").doc(ownerUid).get();
  return (userSnap.data()?.email as string | undefined) ?? null;
}

/**
 * Resend email dispatch for subscription lifecycle events (Phase 4, Section
 * 7). Fire-and-forget by design: email failure never blocks a Firestore
 * subscription update, per the confirmed architectural decision. Every
 * failure is logged as an operational event, not silently swallowed.
 */

export type SubscriptionEmailTrigger =
  | "activated"
  | "renewed"
  | "payment_failed_first"
  | "grace_period_t_minus_2"
  | "cancelled"
  | "reactivated"
  | "plan_changed_upgrade"
  | "plan_changed_downgrade_pending"
  | "downgrade_effective_checkout_required"
  | "expired"
  | "admin_override_applied";

const SUBJECTS: Record<SubscriptionEmailTrigger, (plan?: string, date?: string) => string> = {
  activated: (plan) => `Your Platform ${plan ?? ""} subscription is active`.replace("  ", " "),
  renewed: () => "Your Platform subscription has renewed",
  payment_failed_first: () => "Action required: payment failed for your Platform subscription",
  grace_period_t_minus_2: () => "Your Platform access ends in 2 days",
  cancelled: () => "Your Platform subscription has been cancelled",
  reactivated: () => "Your Platform subscription has been reactivated",
  plan_changed_upgrade: (plan) => `You have been upgraded to ${plan ?? "a new plan"}, effective now`,
  plan_changed_downgrade_pending: (plan, date) => `Your plan will change to ${plan ?? "a new plan"} on ${date ?? "your next billing date"}`,
  downgrade_effective_checkout_required: (plan) => `Action required to continue on ${plan ?? "your requested plan"}`,
  expired: () => "Your Platform subscription has ended",
  admin_override_applied: () => "Your Platform plan has been temporarily adjusted",
};

function getResendKey(): string {
  return process.env.RESEND_API_KEY ?? "";
}

export async function sendSubscriptionEmail(
  toEmail: string,
  trigger: SubscriptionEmailTrigger,
  context?: { plan?: string; date?: string; vendorId?: string }
): Promise<void> {
  const subject = SUBJECTS[trigger](context?.plan, context?.date);

  if (process.env.FUNCTIONS_EMULATOR === "true" || !getResendKey()) {
    // No live Resend call in the emulator or when unconfigured — logged as
    // an operational event so acceptance tests can assert dispatch was
    // attempted without needing a real Resend account.
    logOperationalEvent({
      functionName: "sendSubscriptionEmail",
      event: "email_dispatch_skipped_no_provider",
      severity: "WARNING",
      metadata: { toEmail, trigger, subject, vendorId: context?.vendorId },
    });
    return;
  }

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${getResendKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Platform <billing@example.com>",
        to: [toEmail],
        subject,
        html: `<p>${subject}</p>`,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      logOperationalEvent({
        functionName: "sendSubscriptionEmail",
        event: "email_dispatch_failed",
        severity: "WARNING",
        metadata: { toEmail, trigger, statusCode: resp.status, responseBody: text },
      });
    }
  } catch (err) {
    logOperationalEvent({
      functionName: "sendSubscriptionEmail",
      event: "email_dispatch_failed",
      severity: "WARNING",
      metadata: { toEmail, trigger, errorMessage: err instanceof Error ? err.message : String(err) },
    });
  }
}
