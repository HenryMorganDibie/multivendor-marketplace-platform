"use client";

import { Building2, Lock, ShieldCheck } from "lucide-react";
import { useVendorAuth } from "@/lib/useVendorAuth";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge, StatusTone } from "@/components/StatusBadge";

// Real values from VerificationStatus (functions/src/types.ts). Labels and
// tones matched exactly to the Ops Console's vendor table pills (Verified/
// green, Pending/blue, Retry Required/amber, Rejected/red) so the same
// status reads identically in both apps.
const VERIFICATION_DISPLAY: Record<string, { label: string; tone: StatusTone }> = {
  not_started: { label: "Not started", tone: "neutral" },
  pending_review: { label: "Pending", tone: "info" },
  retry_required: { label: "Retry Required", tone: "warning" },
  approved: { label: "Verified", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
};

/**
 * A single label/value line, not a stacked two-line block.
 *
 * Each field used to be label-above-value inside a two-column grid with 16px
 * gaps, so six short values (four of which are usually a dash) filled most of
 * a phone screen. Label left, value right on one row cuts the card height by
 * roughly half. `min-w-0` plus `truncate` on the value is what stops a long
 * email pushing the row wider than the viewport.
 */
function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-hairline-soft py-2.5 last:border-b-0">
      <p className="shrink-0 text-body-sm text-ink-secondary">{label}</p>
      <p className="min-w-0 truncate text-body-sm font-medium text-ink" title={value ?? undefined}>
        {value ?? "—"}
      </p>
    </div>
  );
}

export default function AccountPage() {
  const { access, loading } = useVendorAuth();

  if (loading || !access) return <p className="text-sm text-gray-500">Loading…</p>;

  const initial = (access.businessName ?? "L").trim().charAt(0).toUpperCase();
  const verification = VERIFICATION_DISPLAY[access.verificationStatus ?? ""] ?? { label: access.verificationStatus ?? "—", tone: "neutral" as StatusTone };

  return (
    <div className="max-w-2xl">
      <PageHeader title="Your account" description="Business details and verification status for your Platform vendor account." />

      {/**
        * Identity, location and verification in one card. Verification used to
        * appear twice on this page: as a badge up here and again as its own
        * card at the very bottom, several hundred pixels away, saying the same
        * word. The bottom card is gone and this is the single place it lives.
        */}
      <div className="mt-section-y rounded-card border border-hairline p-card-p">
        <div className="flex items-center gap-3.5">
          {access.logoImage ? (
            <img src={access.logoImage} alt={access.businessName ?? ""} className="h-12 w-12 shrink-0 rounded-full object-cover" />
          ) : (
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-light text-card-title text-brand">
              {initial}
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate text-card-title text-ink">{access.businessName ?? "—"}</p>
            {access.username && <p className="truncate text-body-sm text-ink-secondary">@{access.username}</p>}
            {(access.area || access.country) && (
              <p className="truncate text-label-sm text-ink-tertiary">
                {[access.area, access.country].filter(Boolean).join(", ")}
              </p>
            )}
          </div>
        </div>

        {access.verificationStatus && (
          <div className="mt-3.5 flex items-center gap-2 border-t border-hairline-soft pt-3.5">
            <ShieldCheck size={15} className="shrink-0 text-ink-tertiary" />
            <span className="text-body-sm text-ink-secondary">Verification</span>
            <span className="ml-auto">
              <StatusBadge label={verification.label} tone={verification.tone} />
            </span>
          </div>
        )}
      </div>

      <div className="mt-section-y rounded-card border border-hairline p-card-p">
        <div className="flex items-center gap-2">
          <Building2 size={15} className="text-ink-tertiary" />
          <p className="text-card-title text-ink">Business details</p>
        </div>
        {/* Single column on purpose: these are label/value rows now, and two
            columns of them on a phone is what produced the wasted space. */}
        <div className="mt-2">
          <Field label="Business name" value={access.businessName ?? null} />
          <Field label="Category" value={access.categoryName ?? null} />
          <Field label="Area" value={access.area ?? null} />
          <Field label="Country" value={access.country ?? null} />
          <Field label="Email" value={access.email ?? null} />
          <Field label="Phone" value={access.phone ?? null} />
        </div>

        {/* Was a four-line paragraph explaining cooldowns and support review.
            Trimmed to the two facts a vendor needs from this screen. */}
        <div className="mt-3.5 flex items-start gap-2.5 border-t border-hairline-soft pt-3.5">
          <Lock size={15} className="mt-0.5 shrink-0 text-ink-tertiary" />
          <p className="text-label-sm text-ink-secondary">
            <span className="font-semibold text-ink">Business details are read-only.</span> Manage your business information in
            the Platform mobile app. Some account and verification changes need Platform support.
          </p>
        </div>
      </div>
    </div>
  );
}
