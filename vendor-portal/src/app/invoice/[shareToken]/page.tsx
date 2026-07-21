import type { Metadata } from "next";
import InvoiceView from "./InvoiceView";

export const metadata: Metadata = {
  title: "Invoice",
  robots: { index: false, follow: false },
};

export default async function PublicInvoicePage({ params }: { params: Promise<{ shareToken: string }> }) {
  const { shareToken } = await params;
  return (
    <section id="main-content" className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <InvoiceView shareToken={shareToken} />
    </section>
  );
}
