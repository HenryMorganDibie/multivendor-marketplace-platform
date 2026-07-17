import type { Metadata } from "next";
import Link from "next/link";
import RichText from "@/components/RichText";
import { getPublishedSiteContent, sectionOrFallback } from "@/lib/siteContent";
import { SiteContentSectionContent } from "@/lib/types";

export const metadata: Metadata = {
  title: "the platform — The Marketplace Built for Direct Trade",
  description:
    "Browse vendors, chat directly, order, and pay — all in one marketplace built for how people actually buy and sell.",
  alternates: { canonical: "/" },
};

const FALLBACK: SiteContentSectionContent = {
  nodes: [
    { type: "heading", level: 1, text: "Buy and sell, directly." },
    {
      type: "paragraph",
      text: "the platform connects customers and vendors without the middleman markup — browse, chat, order, and pay in one place.",
    },
  ],
};

export default async function HomePage() {
  const sections = await getPublishedSiteContent();
  const { content } = sectionOrFallback(sections, "home", FALLBACK);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Organization",
            name: "the platform",
            url: process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.the platform.com",
          }),
        }}
      />
      <section className="bg-white">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
          <div className="max-w-2xl">
            <RichText content={content} />
            <div className="mt-8 flex flex-wrap gap-4">
              <Link
                href="/vendors"
                className="rounded-button bg-brand px-6 py-3 text-sm font-semibold text-white shadow-soft-md transition hover:bg-brand-dark"
              >
                Become a Vendor
              </Link>
              <Link
                href="/customers"
                className="rounded-button border border-hairline-strong bg-white px-6 py-3 text-sm font-semibold text-ink transition hover:border-brand hover:text-brand"
              >
                Shop on the platform
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="grid gap-8 sm:grid-cols-3">
          {[
            { title: "Direct chat", body: "Message vendors directly to ask questions before you buy." },
            { title: "Real vendors", body: "Every vendor goes through verification before they can sell." },
            { title: "Simple checkout", body: "Pay securely with the payment method available in your country." },
          ].map((item) => (
            <div key={item.title} className="rounded-card border border-hairline p-6 shadow-soft">
              <h3 className="text-lg font-bold tracking-[-0.01em] text-ink">{item.title}</h3>
              <p className="mt-2 text-sm text-ink-secondary">{item.body}</p>
            </div>
          ))}
        </div>
        <div className="mt-10 text-center">
          <Link href="/features" className="text-sm font-semibold text-brand hover:text-brand-dark">
            See all features &rarr;
          </Link>
        </div>
      </section>
    </>
  );
}
