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

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</p>
      <p className="mt-1 text-sm font-medium">{value ?? "—"}</p>
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
      <PageHeader title="Your account" description="Business details and verification status for your the platform vendor account." />

      <div className="mt-6 flex items-center gap-4 rounded-2xl border border-gray-100 p-5 dark:border-gray-800">
        {access.logoImage ? (
          <img src={access.logoImage} alt={access.businessName ?? ""} className="h-14 w-14 rounded-full object-cover" />
        ) : (
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-light text-lg font-semibold text-brand">
            {initial}
          </span>
        )}
        <div>
          <p className="text-base font-semibold">{access.businessName ?? "—"}</p>
          {access.username && <p className="text-sm text-gray-500 dark:text-gray-400">@{access.username}</p>}
        </div>
        {access.verificationStatus && <StatusBadge label={verification.label} tone={verification.tone} />}
      </div>

      <div className="mt-6 rounded-2xl border border-gray-100 p-5 dark:border-gray-800">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Building2 size={16} className="text-gray-400" />
          Business details
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Business name" value={access.businessName ?? null} />
          <Field label="Category" value={access.categoryName ?? null} />
          <Field label="Area" value={access.area ?? null} />
          <Field label="Country" value={access.country ?? null} />
          <Field label="Email" value={access.email ?? null} />
          <Field label="Phone" value={access.phone ?? null} />
        </div>
      </div>

      <div className="mt-6 flex items-start gap-3 rounded-2xl border border-gray-100 bg-surface-canvas p-5 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
        <Lock size={16} className="mt-0.5 shrink-0 text-gray-400" />
        <p>
          These details are read-only here for now — editing business info, category, and contact details happens in the the platform mobile
          app. Username changes there are subject to a cooldown period, and some fields (like verification status) can only be changed by
          the platform support after review.
        </p>
      </div>

      <div className="mt-4 flex items-start gap-3 rounded-2xl border border-gray-100 p-5 text-sm text-gray-600 dark:border-gray-800 dark:text-gray-400">
        <ShieldCheck size={16} className="mt-0.5 shrink-0 text-gray-400" />
        <p>Verification status: <span className="font-medium text-gray-900 dark:text-gray-100">{verification.label}</span></p>
      </div>
    </div>
  );
}
