"use client";

import { useEffect, useState } from "react";
import { callable } from "@/lib/firebase";

/**
 * The public invoice page.
 *
 * An external customer has no account and no app. They get a link carrying an
 * unguessable token and open it in whatever browser they have. Until now that
 * link pointed at nothing: getPublicInvoice has been deployed since Phase 3 and
 * the only thing that rendered it was a screen inside the mobile app, which is
 * exactly the audience that does not have it.
 *
 * The token is the credential, so there is no sign-in. That puts two
 * obligations on this page. It must show the current state of the invoice
 * rather than a cached copy, because a vendor can revise an unpaid invoice and
 * the customer refreshing is how they find out. And it must never render
 * anything the token does not entitle the holder to see. The backend already
 * strips the share token from what it returns, so possessing one link never
 * yields the means to guess another.
 */

interface PublicInvoice {
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  lineItems: { description: string; quantity: number; unitPrice: number; total: number }[];
  subtotal: number;
  currency: string;
  status: "unpaid" | "partial" | "paid" | "overpaid" | "cancelled";
  amountPaidMinorUnits?: number;
  balanceMinorUnits?: number;
  notes?: string | null;
  dueDate?: { seconds: number } | string | null;
  revisionCount?: number;
  paidAt?: { seconds: number } | string | null;
}

interface Branding {
  logoUrl?: string | null;
  brandColor?: string | null;
  thankYouMessage?: string | null;
  footerText?: string | null;
}

interface Response {
  success: true;
  invoice: PublicInvoice;
  branding: Branding | null;
}

/**
 * Amounts are stored in minor units: the smallest unit the currency has, with
 * no decimals anywhere near them. The exponent is not a flat two: yen and the
 * CFA franc have none, several Gulf currencies have three. Intl knows this, so
 * it is asked rather than assumed.
 */
function formatMoney(minorUnits: number, currency: string): string {
  const fmt = new Intl.NumberFormat(undefined, { style: "currency", currency });
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  return fmt.format(minorUnits / Math.pow(10, digits));
}

function formatDate(value: PublicInvoice["dueDate"]): string | null {
  if (!value) return null;
  const date =
    typeof value === "string" ? new Date(value) : new Date(value.seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

const STATUS_LABEL: Record<PublicInvoice["status"], string> = {
  unpaid: "Unpaid",
  partial: "Partly paid",
  paid: "Paid",
  overpaid: "Overpaid",
  cancelled: "Cancelled",
};

const STATUS_TONE: Record<PublicInvoice["status"], string> = {
  unpaid: "#B45309",
  partial: "#B45309",
  paid: "#15803D",
  overpaid: "#15803D",
  cancelled: "#6B7280",
};

export default function InvoiceView({ shareCode }: { shareCode: string }) {
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchInvoice = callable<{ shareToken: string }, Response>("getPublicInvoice");

    fetchInvoice({ shareToken: shareCode })
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((err: { message?: string }) => {
        if (cancelled) return;
        // A cancelled or revoked link is an ordinary outcome, not a fault. The
        // backend's message says which; anything unrecognised gets a neutral
        // line rather than a stack trace in front of a customer.
        setError(err?.message ?? "This invoice is no longer available.");
      });

    return () => { cancelled = true; };
  }, [shareCode]);

  if (error) {
    return (
      <main style={S.page}>
        <div style={S.card}>
          <h1 style={S.errorTitle}>Invoice unavailable</h1>
          <p style={S.errorBody}>{error}</p>
          <p style={S.errorHint}>
            If you were expecting an invoice, ask the business to send you a new link.
          </p>
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main style={S.page}>
        <div style={S.card}>
          <p style={S.loading}>Loading invoice…</p>
        </div>
      </main>
    );
  }

  const { invoice, branding } = data;
  const accent = branding?.brandColor || "#FF8C42";
  const paid = invoice.amountPaidMinorUnits ?? 0;
  const balance = invoice.balanceMinorUnits ?? invoice.subtotal - paid;
  const due = formatDate(invoice.dueDate);

  return (
    <main style={S.page}>
      <div style={S.card}>
        <header style={{ ...S.header, borderColor: accent }}>
          <div>
            {branding?.logoUrl ? (
              // Resolved by the backend; a raw storage path would not load here.
              <img src={branding.logoUrl} alt="" style={S.logo} />
            ) : null}
            <p style={S.invoiceNumber}>{invoice.invoiceNumber}</p>
          </div>
          <span style={{ ...S.status, color: STATUS_TONE[invoice.status] }}>
            {STATUS_LABEL[invoice.status]}
          </span>
        </header>

        {invoice.revisionCount ? (
          // A vendor may revise an unpaid invoice. Saying so is the difference
          // between a correction and an amount that moved quietly.
          <p style={S.revised}>This invoice has been updated since it was first sent.</p>
        ) : null}

        <p style={S.billedTo}>Billed to {invoice.customerName}</p>
        {due ? <p style={S.due}>Due {due}</p> : null}

        <table style={S.table}>
          <thead>
            <tr>
              <th style={{ ...S.th, textAlign: "left" }}>Item</th>
              <th style={S.th}>Qty</th>
              <th style={{ ...S.th, textAlign: "right" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lineItems.map((li, i) => (
              <tr key={i}>
                <td style={S.td}>{li.description}</td>
                <td style={{ ...S.td, textAlign: "center" }}>{li.quantity}</td>
                <td style={{ ...S.td, textAlign: "right" }}>
                  {formatMoney(li.total ?? li.quantity * li.unitPrice, invoice.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={S.totals}>
          <Row label="Subtotal" value={formatMoney(invoice.subtotal, invoice.currency)} />
          {paid > 0 ? (
            <Row label="Paid" value={`− ${formatMoney(paid, invoice.currency)}`} />
          ) : null}
          <Row
            label={balance > 0 ? "Amount due" : "Total"}
            value={formatMoney(balance > 0 ? balance : invoice.subtotal, invoice.currency)}
            strong
            accent={accent}
          />
        </div>

        {invoice.notes ? <p style={S.notes}>{invoice.notes}</p> : null}
        {branding?.thankYouMessage ? (
          <p style={S.thankYou}>{branding.thankYouMessage}</p>
        ) : null}

        <footer style={S.footer}>
          {branding?.footerText ? <p>{branding.footerText}</p> : null}
          {/* No payment button. Payment is arranged with the business directly
              and recorded by them; offering one here would imply Platform takes
              the money, which it does not. */}
          <p style={S.poweredBy}>Invoice sent with Platform</p>
        </footer>
      </div>
    </main>
  );
}

function Row({ label, value, strong, accent }: {
  label: string; value: string; strong?: boolean; accent?: string;
}) {
  return (
    <div style={{ ...S.row, ...(strong ? S.rowStrong : {}) }}>
      <span>{label}</span>
      <span style={strong && accent ? { color: accent } : undefined}>{value}</span>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#F6F7F9",
    padding: "32px 16px",
    display: "flex",
    justifyContent: "center",
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    color: "#111827",
  },
  card: {
    width: "100%",
    maxWidth: 640,
    background: "#FFFFFF",
    borderRadius: 16,
    padding: "28px 24px 20px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    borderBottom: "3px solid",
    paddingBottom: 16,
    marginBottom: 18,
    gap: 16,
  },
  logo: { maxHeight: 44, maxWidth: 160, objectFit: "contain", marginBottom: 8, display: "block" },
  invoiceNumber: { fontSize: 20, fontWeight: 700, margin: 0, letterSpacing: "-0.01em" },
  status: { fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" },
  revised: {
    background: "#FFF7ED", color: "#9A3412", borderRadius: 8,
    padding: "10px 12px", fontSize: 13, margin: "0 0 16px",
  },
  billedTo: { fontSize: 15, margin: "0 0 4px", color: "#374151" },
  due: { fontSize: 13, margin: "0 0 20px", color: "#6B7280" },
  table: { width: "100%", borderCollapse: "collapse", marginBottom: 18 },
  th: {
    fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em",
    color: "#6B7280", fontWeight: 600, padding: "0 0 8px", borderBottom: "1px solid #E5E7EB",
  },
  td: { fontSize: 14, padding: "12px 0", borderBottom: "1px solid #F3F4F6", verticalAlign: "top" },
  totals: { marginTop: 4 },
  row: { display: "flex", justifyContent: "space-between", fontSize: 14, padding: "6px 0", color: "#374151" },
  rowStrong: { fontSize: 18, fontWeight: 700, paddingTop: 12, marginTop: 6, borderTop: "1px solid #E5E7EB", color: "#111827" },
  notes: { fontSize: 13, color: "#4B5563", marginTop: 20, whiteSpace: "pre-wrap", lineHeight: 1.5 },
  thankYou: { fontSize: 14, color: "#111827", marginTop: 16, fontWeight: 500 },
  footer: { marginTop: 28, paddingTop: 16, borderTop: "1px solid #F3F4F6", fontSize: 12, color: "#6B7280" },
  poweredBy: { marginTop: 8, fontSize: 11, color: "#9CA3AF" },
  loading: { fontSize: 14, color: "#6B7280", textAlign: "center", padding: "40px 0" },
  errorTitle: { fontSize: 20, fontWeight: 700, margin: "0 0 8px" },
  errorBody: { fontSize: 14, color: "#4B5563", margin: "0 0 12px", lineHeight: 1.5 },
  errorHint: { fontSize: 13, color: "#6B7280", margin: 0 },
};
