import type { Metadata } from "next";
import RichText from "@/components/RichText";
import { AppStoreBadge, GooglePlayBadge } from "@/components/AppBadges";
import { getPublishedSiteContent, sectionOrFallback } from "@/lib/siteContent";
import { SiteContentSectionContent } from "@/lib/types";

export const metadata: Metadata = {
  title: "Shop on the platform",
  description: "Browse verified vendors, chat directly, and order with confidence on the platform.",
  alternates: { canonical: "/customers" },
};

const FALLBACK: SiteContentSectionContent = {
  nodes: [
    { type: "heading", level: 1, text: "Shop from vendors you can actually talk to." },
    {
      type: "paragraph",
      text: "Browse verified vendors near you, ask questions before you buy, and track every order from checkout to pickup.",
    },
  ],
};

const BENEFITS = ["Browse vendors", "Search", "Chat before ordering", "Track orders", "Reviews", "Favorites", "Notifications"];

const JOURNEY = [
  { label: "Browse", body: "Find verified vendors near you, by category or search." },
  { label: "Chat", body: "Ask questions directly before you commit to buying." },
  { label: "Order", body: "Place your order and pay with what's available in your country." },
  { label: "Receive", body: "Track it through to pickup or delivery." },
];

const CUSTOMER_SCREENSHOTS = ["Home", "Vendor Store", "Chat", "Order", "Tracking", "Reviews"];

const CUSTOMER_FAQ = [
  { q: "Can I contact vendors?", a: "Yes — you can message a vendor directly to ask questions before you commit to buying anything." },
  { q: "How do I order?", a: "Browse a vendor's catalog, add what you want, and check out with the payment method available in your country." },
  { q: "How do I pay?", a: "the platform supports the payment methods available in your country, selected automatically at checkout." },
  { q: "Can I cancel?", a: "Order cancellation depends on where it is in the vendor's fulfillment process — message the vendor directly to ask." },
];

function ScreenshotPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex aspect-[9/16] flex-col items-center justify-center gap-2 rounded-card-lg border-2 border-dashed border-hairline-strong bg-surface-canvas text-center">
      <span className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">Coming soon</span>
      <span className="px-4 text-sm font-medium text-ink-secondary">{label}</span>
    </div>
  );
}

export default async function CustomersPage() {
  const sections = await getPublishedSiteContent();
  const { content } = sectionOrFallback(sections, "customers", FALLBACK);

  return (
    <>
      <section className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <RichText content={content} />
        <div className="mt-6 flex flex-wrap gap-3">
          <AppStoreBadge href="https://apps.apple.com/" />
          <GooglePlayBadge href="https://play.google.com/store" />
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 pb-12 sm:px-6">
        <h2 className="text-xl font-bold tracking-[-0.015em] text-ink">What you get</h2>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {BENEFITS.map((benefit) => (
            <div key={benefit} className="rounded-button border border-hairline bg-surface px-4 py-3 text-center text-sm font-semibold text-ink">
              {benefit}
            </div>
          ))}
        </div>
      </section>

      <section className="bg-surface-canvas">
        <div className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
          <h2 className="text-xl font-bold tracking-[-0.015em] text-ink">Your journey</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            {JOURNEY.map((step, i) => (
              <div key={step.label} className="rounded-card border border-hairline bg-white p-4 shadow-soft">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-light text-xs font-bold text-brand">
                  {i + 1}
                </span>
                <p className="mt-2 font-bold tracking-[-0.01em] text-ink">{step.label}</p>
                <p className="mt-1 text-sm text-ink-secondary">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
        <h2 className="text-xl font-bold tracking-[-0.015em] text-ink">See the Customer experience</h2>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {CUSTOMER_SCREENSHOTS.map((label) => (
            <ScreenshotPlaceholder key={label} label={label} />
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 pb-16 sm:px-6">
        <h2 className="text-xl font-bold tracking-[-0.015em] text-ink">FAQ</h2>
        <div className="mt-4 space-y-5">
          {CUSTOMER_FAQ.map((item) => (
            <div key={item.q}>
              <p className="font-semibold text-ink">{item.q}</p>
              <p className="mt-1 text-sm text-ink-secondary">{item.a}</p>
            </div>
          ))}
        </div>
        <p className="mt-6 text-sm">
          <a href="/faq" className="font-semibold text-brand hover:text-brand-dark">
            See the full FAQ &rarr;
          </a>
        </p>
      </section>
    </>
  );
}
