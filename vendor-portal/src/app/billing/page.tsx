"use client";

import { useEffect, useMemo, useState } from "react";
import { Receipt, Search, X } from "lucide-react";
import { callable } from "@/lib/firebase";
import { VendorBillingHistoryEntry } from "@/lib/types";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge, StatusTone } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";

// Real statuses come from the backend's plain-language mapping in
// getVendorBillingHistory (subscriptionEvents normalizedEventType) — there
// is no "Refunded" event type today, so it's intentionally not offered as
// a filter here rather than shown as a dead option.
const STATUS_TONE: Record<string, StatusTone> = {
  Paid: "success",
  "Payment issue": "danger",
  Cancelled: "neutral",
  "Trial ending": "warning",
  "Plan adjusted by support": "info",
  "No action taken": "neutral",
  Processed: "neutral",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatAmount(amount: number | null, currency: string | null): string {
  if (amount === null || !currency) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount / 100);
  } catch {
    return `${currency} ${(amount / 100).toFixed(2)}`;
  }
}

export default function BillingHistoryPage() {
  const [entries, setEntries] = useState<VendorBillingHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    const getHistory = callable<{ limit: number }, { success: true; entries: VendorBillingHistoryEntry[] }>("getVendorBillingHistory");
    getHistory({ limit: 50 })
      .then((res) => setEntries(res.data.entries))
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load billing history."));
  }, []);

  const statusOptions = useMemo(() => {
    const set = new Set((entries ?? []).map((e) => e.paymentStatus));
    return Array.from(set);
  }, [entries]);

  const filtered = useMemo(() => {
    let list = entries ?? [];
    if (statusFilter !== "all") list = list.filter((e) => e.paymentStatus === statusFilter);
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (e) => e.plan.toLowerCase().includes(q) || (e.providerReference ?? "").toLowerCase().includes(q)
      );
    }
    return list;
  }, [entries, statusFilter, searchQuery]);

  return (
    <div>
      <PageHeader title="Billing history" description="Review subscription payments and billing activity." />

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {entries !== null && entries.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setStatusFilter("all")}
              className={`rounded-full border px-3.5 py-1.5 text-sm font-medium ${
                statusFilter === "all"
                  ? "border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900"
                  : "border-gray-200 text-gray-600 hover:border-gray-300 dark:border-gray-800 dark:text-gray-400"
              }`}
            >
              All
            </button>
            {statusOptions.map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => setStatusFilter(status)}
                className={`rounded-full border px-3.5 py-1.5 text-sm font-medium ${
                  statusFilter === status
                    ? "border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900"
                    : "border-gray-200 text-gray-600 hover:border-gray-300 dark:border-gray-800 dark:text-gray-400"
                }`}
              >
                {status}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            {showSearch && (
              <div className="flex items-center gap-2 rounded-full border border-gray-200 px-3 py-1.5 dark:border-gray-800">
                <Search size={15} className="text-gray-400" />
                <input
                  autoFocus
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search plan or reference"
                  className="w-44 bg-transparent text-sm outline-none sm:w-56"
                />
                {searchQuery.length > 0 && (
                  <button type="button" onClick={() => setSearchQuery("")} className="text-gray-400 hover:text-gray-600">
                    <X size={14} />
                  </button>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                setShowSearch((v) => !v);
                if (showSearch) setSearchQuery("");
              }}
              aria-label="Toggle search"
              className={`flex h-9 w-9 items-center justify-center rounded-full border ${
                showSearch ? "border-brand text-brand" : "border-gray-200 text-gray-500 hover:border-gray-300 dark:border-gray-800 dark:text-gray-400"
              }`}
            >
              <Search size={16} />
            </button>
          </div>
        </div>
      )}

      {entries === null && !error && <p className="mt-8 text-sm text-gray-500">Loading…</p>}

      {entries !== null && entries.length === 0 && (
        <div className="mt-8">
          <EmptyState icon={Receipt} title="No billing history yet" description="Payments and plan changes will show up here." />
        </div>
      )}

      {entries !== null && entries.length > 0 && filtered.length === 0 && (
        <div className="mt-8">
          <EmptyState icon={Search} title="No matching records" description="Try a different search or filter." />
        </div>
      )}

      {filtered.length > 0 && (
        <>
          {/* Desktop table */}
          <div className="mt-6 hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-gray-500 dark:border-gray-800">
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">Plan</th>
                  <th className="py-2 pr-4 font-medium">Amount</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 font-medium">Reference</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((entry, i) => (
                  <tr key={i} className="border-b border-gray-100 dark:border-gray-900">
                    <td className="py-3 pr-4">{formatDate(entry.paymentDate)}</td>
                    <td className="py-3 pr-4 capitalize">{entry.plan.replace("_", "+")}</td>
                    <td className="py-3 pr-4 font-medium">{formatAmount(entry.amount, entry.currency)}</td>
                    <td className="py-3 pr-4">
                      <StatusBadge label={entry.paymentStatus} tone={STATUS_TONE[entry.paymentStatus] ?? "neutral"} />
                    </td>
                    <td className="py-3 max-w-[160px] truncate text-xs text-gray-500" title={entry.providerReference ?? undefined}>
                      {entry.providerReference ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="mt-6 space-y-2.5 sm:hidden">
            {filtered.map((entry, i) => (
              <div key={i} className="rounded-2xl border border-gray-100 p-4 dark:border-gray-800">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold capitalize">{entry.plan.replace("_", "+")}</p>
                  <StatusBadge label={entry.paymentStatus} tone={STATUS_TONE[entry.paymentStatus] ?? "neutral"} />
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{formatDate(entry.paymentDate)}</p>
                <div className="mt-3 flex items-center justify-between">
                  <p className="text-sm font-semibold">{formatAmount(entry.amount, entry.currency)}</p>
                  {entry.providerReference && <p className="max-w-[140px] truncate text-xs text-gray-400">{entry.providerReference}</p>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
