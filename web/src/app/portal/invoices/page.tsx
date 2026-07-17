"use client";

import { SyntheticEvent, useEffect, useState } from "react";
import { callable } from "@/lib/firebase";
import { InvoiceLineItem, InvoiceSummary } from "@/lib/types";

interface ListInvoicesResponse {
  success: true;
  invoices: InvoiceSummary[];
}

interface CreateInvoiceResponse {
  success: true;
  invoiceId: string;
  invoiceNumber: string;
}

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.the platform.com";

function statusBadgeClass(status: string): string {
  if (status === "paid") return "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300";
  if (status === "cancelled") return "bg-gray-100 text-gray-600 dark:bg-gray-900 dark:text-gray-400";
  return "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300";
}

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState<InvoiceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [lineItems, setLineItems] = useState<InvoiceLineItem[]>([{ description: "", quantity: 1, unitPrice: 0, total: 0 }]);
  const [selectedShareLink, setSelectedShareLink] = useState<string | null>(null);

  function loadInvoices() {
    setError(null);
    const list = callable<Record<string, never>, ListInvoicesResponse>("listInvoices");
    list({})
      .then((res) => setInvoices(res.data.invoices))
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load invoices."));
  }

  useEffect(() => {
    loadInvoices();
  }, []);

  function updateLineItem(index: number, field: keyof InvoiceLineItem, value: string) {
    setLineItems((prev) =>
      prev.map((item, i) => {
        if (i !== index) return item;
        const next = { ...item, [field]: field === "description" ? value : Number(value) };
        next.total = next.quantity * next.unitPrice;
        return next;
      })
    );
  }

  async function handleCreate(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    const form = e.currentTarget;
    const formData = new FormData(form);
    try {
      const create = callable<Record<string, unknown>, CreateInvoiceResponse>("createInvoice");
      await create({
        customerName: formData.get("customerName"),
        customerPhone: formData.get("customerPhone") || undefined,
        customerEmail: formData.get("customerEmail") || undefined,
        notes: formData.get("notes") || undefined,
        lineItems,
      });
      form.reset();
      setLineItems([{ description: "", quantity: 1, unitPrice: 0, total: 0 }]);
      setShowForm(false);
      loadInvoices();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create invoice.");
    } finally {
      setCreating(false);
    }
  }

  async function handleDownload(invoiceId: string, invoiceNumber: string) {
    setError(null);
    try {
      const download = callable<{ invoiceId: string }, { pdfBase64: string; fileName: string }>("downloadInvoicePdf");
      const res = await download({ invoiceId });
      const link = document.createElement("a");
      link.href = `data:application/pdf;base64,${res.data.pdfBase64}`;
      link.download = res.data.fileName || `${invoiceNumber}.pdf`;
      link.click();
    } catch (err) {
      setError(err instanceof Error ? err.message : "PDF download isn't available on your current plan.");
    }
  }

  function handleShare(shareToken: string) {
    const url = `${SITE_URL}/invoice/${shareToken}`;
    setSelectedShareLink(url);
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(url).catch(() => {});
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Invoices</h2>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark"
        >
          {showForm ? "Cancel" : "New Invoice"}
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {selectedShareLink && (
        <p className="mt-3 rounded-lg bg-brand-light p-3 text-sm dark:bg-gray-900">
          Link copied: <span className="font-mono">{selectedShareLink}</span>
        </p>
      )}

      {showForm && (
        <form onSubmit={handleCreate} className="mt-6 space-y-4 rounded-2xl border border-gray-100 p-6 dark:border-gray-800">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="customerName" className="block text-sm font-medium">
                Customer name
              </label>
              <input
                id="customerName"
                name="customerName"
                required
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
              />
            </div>
            <div>
              <label htmlFor="customerPhone" className="block text-sm font-medium">
                Customer phone (optional)
              </label>
              <input
                id="customerPhone"
                name="customerPhone"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
              />
            </div>
          </div>
          <div>
            <label htmlFor="customerEmail" className="block text-sm font-medium">
              Customer email (optional)
            </label>
            <input
              id="customerEmail"
              name="customerEmail"
              type="email"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
          </div>

          <div>
            <p className="text-sm font-medium">Line items</p>
            <div className="mt-2 space-y-2">
              {lineItems.map((item, i) => (
                <div key={i} className="grid grid-cols-[1fr_80px_100px] gap-2">
                  <input
                    placeholder="Description"
                    value={item.description}
                    onChange={(e) => updateLineItem(i, "description", e.target.value)}
                    required
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
                  />
                  <input
                    type="number"
                    min={1}
                    placeholder="Qty"
                    value={item.quantity}
                    onChange={(e) => updateLineItem(i, "quantity", e.target.value)}
                    required
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
                  />
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="Unit price"
                    value={item.unitPrice}
                    onChange={(e) => updateLineItem(i, "unitPrice", e.target.value)}
                    required
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
                  />
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setLineItems((prev) => [...prev, { description: "", quantity: 1, unitPrice: 0, total: 0 }])}
              className="mt-2 text-sm font-medium text-brand hover:text-brand-dark"
            >
              + Add line item
            </button>
          </div>

          <div>
            <label htmlFor="notes" className="block text-sm font-medium">
              Notes (optional)
            </label>
            <textarea
              id="notes"
              name="notes"
              rows={2}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
          </div>

          <button
            type="submit"
            disabled={creating}
            className="rounded-full bg-brand px-6 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create invoice"}
          </button>
        </form>
      )}

      {invoices === null && !error && <p className="mt-6 text-sm text-gray-500">Loading…</p>}
      {invoices !== null && invoices.length === 0 && <p className="mt-6 text-sm text-gray-600 dark:text-gray-400">No invoices yet.</p>}

      {invoices !== null && invoices.length > 0 && (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-gray-500 dark:border-gray-800">
                <th className="py-2 pr-4 font-medium">Invoice #</th>
                <th className="py-2 pr-4 font-medium">Created</th>
                <th className="py-2 pr-4 font-medium">Customer</th>
                <th className="py-2 pr-4 font-medium">Amount</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.invoiceId} className="border-b border-gray-100 dark:border-gray-900">
                  <td className="py-3 pr-4 font-mono text-xs">{inv.invoiceNumber}</td>
                  <td className="py-3 pr-4">
                    {typeof inv.createdAt === "object" && "seconds" in inv.createdAt
                      ? new Date(inv.createdAt.seconds * 1000).toLocaleDateString()
                      : "—"}
                  </td>
                  <td className="py-3 pr-4">{inv.customerName}</td>
                  <td className="py-3 pr-4">
                    {new Intl.NumberFormat(undefined, { style: "currency", currency: inv.currency }).format(inv.subtotal)}
                  </td>
                  <td className="py-3 pr-4">
                    <span className={`rounded-full px-2 py-1 text-xs font-medium ${statusBadgeClass(inv.status)}`}>{inv.status}</span>
                  </td>
                  <td className="py-3">
                    <div className="flex gap-3 text-xs">
                      <button type="button" onClick={() => handleDownload(inv.invoiceId, inv.invoiceNumber)} className="font-medium text-brand hover:text-brand-dark">
                        PDF
                      </button>
                      <button type="button" onClick={() => handleShare(inv.shareToken)} className="font-medium text-brand hover:text-brand-dark">
                        Share
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
