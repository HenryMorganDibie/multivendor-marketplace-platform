"use client";

import { useEffect, useState } from "react";
import { callable } from "@/lib/firebase";
import { InvoiceDoc as InvoiceDocShape } from "./types";

interface GetPublicInvoiceResponse {
  success: true;
  invoice: InvoiceDocShape;
}

export default function InvoiceView({ shareToken }: { shareToken: string }) {
  const [invoice, setInvoice] = useState<InvoiceDocShape | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const getInvoice = callable<{ shareToken: string }, GetPublicInvoiceResponse>("getPublicInvoice");
    getInvoice({ shareToken })
      .then((res) => setInvoice(res.data.invoice))
      .catch((err) => setError(err instanceof Error ? err.message : "This invoice link is no longer valid."));
  }, [shareToken]);

  if (error) {
    return <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  }
  if (!invoice) {
    return <p className="text-sm text-gray-500">Loading invoice…</p>;
  }

  return (
    <div className="rounded-2xl border border-gray-100 p-8 dark:border-gray-800">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xl font-bold text-brand">the platform</p>
          <p className="mt-1 font-mono text-sm text-gray-500">{invoice.invoiceNumber}</p>
        </div>
        <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium capitalize dark:bg-gray-900">{invoice.status}</span>
      </div>

      <div className="mt-6">
        <p className="text-sm text-gray-500">Billed to</p>
        <p className="font-medium">{invoice.customerName}</p>
        {invoice.customerEmail && <p className="text-sm text-gray-600 dark:text-gray-400">{invoice.customerEmail}</p>}
      </div>

      <table className="mt-6 w-full text-left text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-gray-500 dark:border-gray-800">
            <th className="py-2 font-medium">Description</th>
            <th className="py-2 text-right font-medium">Qty</th>
            <th className="py-2 text-right font-medium">Unit price</th>
            <th className="py-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lineItems.map((item, i) => (
            <tr key={i} className="border-b border-gray-100 dark:border-gray-900">
              <td className="py-2">{item.description}</td>
              <td className="py-2 text-right">{item.quantity}</td>
              <td className="py-2 text-right">
                {new Intl.NumberFormat(undefined, { style: "currency", currency: invoice.currency }).format(item.unitPrice)}
              </td>
              <td className="py-2 text-right">
                {new Intl.NumberFormat(undefined, { style: "currency", currency: invoice.currency }).format(item.total)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-4 flex justify-end">
        <p className="text-lg font-bold">
          Total: {new Intl.NumberFormat(undefined, { style: "currency", currency: invoice.currency }).format(invoice.subtotal)}
        </p>
      </div>

      {invoice.notes && <p className="mt-6 text-sm text-gray-600 dark:text-gray-400">{invoice.notes}</p>}
    </div>
  );
}
