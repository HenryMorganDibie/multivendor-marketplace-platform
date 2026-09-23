import type { Metadata } from "next";
import InvoiceView from "./InvoiceView";

/**
 * /i/{shareCode}: the link a vendor sends an external customer.
 *
 * Deliberately outside the (marketing) group, so it carries no site header,
 * navigation or footer. Someone opening this has been sent a bill; putting a
 * pricing menu around it would be strange.
 */

export const metadata: Metadata = {
  title: "Invoice · Platform",
  // Never indexable. These links are unguessable by design, and a search engine
  // that crawled one would put somebody's invoice into results.
  robots: { index: false, follow: false, nocache: true },
};

export default async function PublicInvoicePage({
  params,
}: {
  params: Promise<{ shareCode: string }>;
}) {
  const { shareCode } = await params;
  return <InvoiceView shareCode={shareCode} />;
}
