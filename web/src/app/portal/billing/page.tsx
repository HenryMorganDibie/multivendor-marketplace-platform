"use client";

import { useEffect, useState } from "react";
import { callable } from "@/lib/firebase";
import { VendorBillingHistoryEntry } from "@/lib/types";

export default function BillingHistoryPage() {
  const [entries, setEntries] = useState<VendorBillingHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const getHistory = callable<{ limit: number }, { success: true; entries: VendorBillingHistoryEntry[] }>("getVendorBillingHistory");
    getHistory({ limit: 20 })
      .then((res) => setEntries(res.data.entries))
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load billing history."));
  }, []);

  return (
    <div>
      <h2 className="text-xl font-semibold">Billing History</h2>

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {entries === null && !error && <p className="mt-4 text-sm text-gray-500">Loading…</p>}

      {entries !== null && entries.length === 0 && (
        <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">No billing history yet.</p>
      )}

      {entries !== null && entries.length > 0 && (
        <div className="mt-4 overflow-x-auto">
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
              {entries.map((entry, i) => (
                <tr key={i} className="border-b border-gray-100 dark:border-gray-900">
                  <td className="py-3 pr-4">{entry.paymentDate ? new Date(entry.paymentDate).toLocaleDateString() : "—"}</td>
                  <td className="py-3 pr-4 capitalize">{entry.plan.replace("_", "+")}</td>
                  <td className="py-3 pr-4">
                    {entry.amount !== null && entry.currency
                      ? new Intl.NumberFormat(undefined, { style: "currency", currency: entry.currency }).format(entry.amount / 100)
                      : "—"}
                  </td>
                  <td className="py-3 pr-4">{entry.paymentStatus}</td>
                  <td className="py-3 text-xs text-gray-500">{entry.providerReference ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
