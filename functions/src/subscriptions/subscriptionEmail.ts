import { logOperationalEvent } from "../utils/operationalLogging";

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
  | "expired"
  | "admin_override_applied";

const SUBJECTS: Record<SubscriptionEmailTrigger, (plan?: string, date?: string) => string> = {
  activated: (plan) => `Your the platform ${plan ?? ""} subscription is active`.replace("  ", " "),
  renewed: () => "Your the platform subscription has renewed",
  payment_failed_first: () => "Action required: payment failed for your the platform subscription",
  grace_period_t_minus_2: () => "Your the platform access ends in 2 days",
  cancelled: () => "Your the platform subscription has been cancelled",
  reactivated: () => "Your the platform subscription has been reactivated",
  plan_changed_upgrade: (plan) => `You have been upgraded to ${plan ?? "a new plan"}, effective now`,
  plan_changed_downgrade_pending: (plan, date) => `Your plan will change to ${plan ?? "a new plan"} on ${date ?? "your next billing date"}`,
  expired: () => "Your the platform subscription has ended",
  admin_override_applied: () => "Your the platform plan has been temporarily adjusted",
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
        from: "the platform <billing@theplatform.com>",
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
