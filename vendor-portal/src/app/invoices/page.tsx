"use client";

import { SyntheticEvent, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Clock,
  FileText,
  Plus,
  Search,
  X,
  XCircle,
} from "lucide-react";
import { callable } from "@/lib/firebase";
import { InvoiceLineItem, InvoiceStatus, InvoiceSummary } from "@/lib/types";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge, StatusTone } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";

interface ListInvoicesResponse {
  success: true;
  invoices: InvoiceSummary[];
}

interface CreateInvoiceResponse {
  success: true;
  invoiceId: string;
  invoiceNumber: string;
}

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://vendor.theplatform.com";

type PillKey = "all" | InvoiceStatus;

const PILLS: { key: PillKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unpaid", label: "Unpaid" },
  { key: "paid", label: "Paid" },
  { key: "cancelled", label: "Cancelled" },
];

const STATUS_CONFIG: Record<InvoiceStatus, { label: string; tone: StatusTone; icon: React.ReactNode; iconWrap: string }> = {
  paid: {
    label: "Paid",
    tone: "success",
    icon: <CheckCircle2 size={18} className="text-green-600 dark:text-green-400" />,
    iconWrap: "bg-green-50 dark:bg-green-950",
  },
  unpaid: {
    label: "Unpaid",
    tone: "warning",
    icon: <Clock size={18} className="text-amber-600 dark:text-amber-400" />,
    iconWrap: "bg-amber-50 dark:bg-amber-950",
  },
  cancelled: {
    label: "Cancelled",
    tone: "neutral",
    icon: <XCircle size={18} className="text-gray-500 dark:text-gray-400" />,
    iconWrap: "bg-gray-100 dark:bg-gray-900",
  },
};

function formatDate(value: InvoiceSummary["createdAt"]): string {
  if (typeof value === "object" && value !== null && "seconds" in value) {
    return new Date(value.seconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  if (typeof value === "string") return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return "—";
}

function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState<InvoiceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [lineItems, setLineItems] = useState<InvoiceLineItem[]>([{ description: "", quantity: 1, unitPrice: 0, total: 0 }]);
  const [selectedShareLink, setSelectedShareLink] = useState<string | null>(null);

  const [activePill, setActivePill] = useState<PillKey>("all");
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

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

  const pillCounts = useMemo(() => {
    const list = invoices ?? [];
    return {
      all: list.length,
      unpaid: list.filter((i) => i.status === "unpaid").length,
      paid: list.filter((i) => i.status === "paid").length,
      cancelled: list.filter((i) => i.status === "cancelled").length,
    } as Record<PillKey, number>;
  }, [invoices]);

  const filteredInvoices = useMemo(() => {
    let list = (invoices ?? []).slice();
    if (activePill !== "all") {
      list = list.filter((i) => i.status === activePill);
    }
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (i) =>
          i.invoiceNumber.toLowerCase().includes(q) ||
          i.customerName.toLowerCase().includes(q) ||
          String(i.subtotal).includes(q)
      );
    }
    list.sort((a, b) => {
      const aMs = typeof a.createdAt === "object" ? a.createdAt.seconds * 1000 : new Date(a.createdAt).getTime();
      const bMs = typeof b.createdAt === "object" ? b.createdAt.seconds * 1000 : new Date(b.createdAt).getTime();
      return bMs - aMs;
    });
    return list;
  }, [invoices, activePill, searchQuery]);

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
      <PageHeader
        title="Invoices"
        description="Create and manage invoices sent to your customers."
        action={
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark"
          >
            {showForm ? <X size={16} /> : <Plus size={16} />}
            {showForm ? "Cancel" : "New invoice"}
          </button>
        }
      />

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

      {/* Status pills + search */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {PILLS.map((pill) => {
            const active = activePill === pill.key;
            const count = pillCounts[pill.key];
            return (
              <button
                key={pill.key}
                type="button"
                onClick={() => setActivePill(pill.key)}
                className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  active
                    ? "border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900"
                    : "border-gray-200 text-gray-600 hover:border-gray-300 dark:border-gray-800 dark:text-gray-400 dark:hover:border-gray-700"
                }`}
              >
                {pill.label}
                {count > 0 ? ` (${count})` : ""}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          {showSearch && (
            <div className="flex items-center gap-2 rounded-full border border-gray-200 px-3 py-1.5 dark:border-gray-800">
              <Search size={15} className="text-gray-400" />
              <input
                autoFocus
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search invoices"
                className="w-40 bg-transparent text-sm outline-none sm:w-56"
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
              showSearch
                ? "border-brand text-brand"
                : "border-gray-200 text-gray-500 hover:border-gray-300 dark:border-gray-800 dark:text-gray-400"
            }`}
          >
            <Search size={16} />
          </button>
        </div>
      </div>

      {/* List */}
      {invoices === null && !error && <p className="mt-8 text-sm text-gray-500">Loading…</p>}

      {invoices !== null && filteredInvoices.length === 0 && (
        <div className="mt-10">
          <EmptyState
            icon={invoices.length === 0 ? FileText : Search}
            title={invoices.length === 0 ? "No invoices yet" : "No invoices found"}
            description={invoices.length === 0 ? "Create your first invoice and share it with a customer." : "Try a different search or filter."}
            action={invoices.length === 0 ? { label: "Create invoice", onClick: () => setShowForm(true) } : undefined}
          />
        </div>
      )}

      {invoices !== null && filteredInvoices.length > 0 && (
        <div className="mt-6 space-y-2.5">
          {filteredInvoices.map((inv) => {
            const status = STATUS_CONFIG[inv.status];
            return (
              <div
                key={inv.invoiceId}
                className="flex items-center gap-4 rounded-2xl border border-gray-100 p-4 dark:border-gray-800"
              >
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${status.iconWrap}`}>
                  {status.icon}
                </div>

                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs font-medium text-gray-500 dark:text-gray-400">{inv.invoiceNumber}</p>
                  <p className="truncate text-sm font-semibold">{inv.customerName}</p>
                  <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{formatDate(inv.createdAt)}</p>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <p className="text-sm font-semibold">{formatAmount(inv.subtotal, inv.currency)}</p>
                  <StatusBadge label={status.label} tone={status.tone} />
                </div>

                <div className="ml-2 flex shrink-0 gap-3 border-l border-gray-100 pl-4 text-xs dark:border-gray-800">
                  <button type="button" onClick={() => handleDownload(inv.invoiceId, inv.invoiceNumber)} className="font-medium text-brand hover:text-brand-dark">
                    PDF
                  </button>
                  <button type="button" onClick={() => handleShare(inv.shareToken)} className="font-medium text-brand hover:text-brand-dark">
                    Share
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
