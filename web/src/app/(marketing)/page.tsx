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

// Placeholder hero copy — CMS-editable (siteContent/home), pending
// the client's approved marketing copy. Picked the option that most directly
// states why the platform exists, per the product review's own stated goal.
const FALLBACK: SiteContentSectionContent = {
  nodes: [
    { type: "heading", level: 1, text: "The marketplace where customers and vendors actually talk." },
    {
      type: "paragraph",
      text: "the platform connects customers and vendors directly — chat before you buy, browse verified local businesses, and order with confidence.",
    },
  ],
};

// Real category taxonomy — rork-the platform/expo/constants/categories.ts
// (DAY_ONE_CATEGORIES). Kept in sync manually; update both if the
// mobile app's category list changes.
const VENDOR_CATEGORIES = [
  "Food & Catering",
  "Fashion",
  "Beauty Tools",
  "Home & Living",
  "Electronics Repair",
  "Baby & Kids",
  "Bags & Accessories",
  "Phone Accessories",
  "Art & Handmade",
  "Books & Stationery",
  "Digital Products",
  "Safe Verified Services",
];

const CUSTOMER_STEPS = [
  { label: "Browse", body: "Find verified vendors near you, by category or search." },
  { label: "Chat", body: "Ask questions directly before you commit to buying." },
  { label: "Order", body: "Place your order and pay with what's available in your country." },
  { label: "Receive", body: "Track it through to pickup or delivery." },
];

const VENDOR_STEPS = [
  { label: "Register", body: "Sign up and set up your storefront in the mobile app." },
  { label: "Verify", body: "Submit your business documents for a verified badge customers trust." },
  { label: "Sell", body: "List your catalog and start chatting with customers directly." },
  { label: "Receive orders", body: "Manage orders, invoices, and your subscription plan as you grow." },
];

function StepFlow({ title, steps }: { title: string; steps: { label: string; body: string }[] }) {
  return (
    <div>
      <p className="text-sm font-semibold uppercase tracking-wide text-brand">{title}</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-4">
        {steps.map((step, i) => (
          <div key={step.label} className="relative rounded-card border border-hairline p-5 shadow-soft">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-light text-sm font-bold text-brand">
              {i + 1}
            </span>
            <p className="mt-3 font-bold tracking-[-0.01em] text-ink">{step.label}</p>
            <p className="mt-1 text-sm text-ink-secondary">{step.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ScreenshotPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex aspect-[9/16] flex-col items-center justify-center gap-2 rounded-card-lg border-2 border-dashed border-hairline-strong bg-surface-canvas text-center">
      <span className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">Coming soon</span>
      <span className="px-4 text-sm font-medium text-ink-secondary">{label} screenshot</span>
    </div>
  );
}

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

      {/* Hero */}
      <section className="bg-white">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
          <div className="max-w-2xl">
            <RichText content={content} />
            <div className="mt-8 flex flex-wrap gap-4">
              <a
                href="https://apps.apple.com/"
                className="rounded-button bg-black px-6 py-3 text-sm font-semibold text-white shadow-soft-md transition hover:bg-gray-800"
              >
                Download on the App Store
              </a>
              <a
                href="https://play.google.com/store"
                className="rounded-button bg-black px-6 py-3 text-sm font-semibold text-white shadow-soft-md transition hover:bg-gray-800"
              >
                Get it on Google Play
              </a>
            </div>
            <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <Link href="/vendors" className="font-medium text-brand hover:text-brand-dark">
                Become a Vendor &rarr;
              </Link>
              <Link href="/customers" className="font-medium text-brand hover:text-brand-dark">
                Shop on the platform &rarr;
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Why the platform */}
      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 className="text-2xl font-bold tracking-[-0.015em] text-ink">Why the platform</h2>
        <div className="mt-6 grid gap-8 sm:grid-cols-3">
          {[
            { title: "Chat before buying", body: "Message vendors directly to ask questions before you buy." },
            { title: "Direct vendor communication", body: "No middleman — every conversation goes straight to the business." },
            { title: "Local verified businesses", body: "Every vendor goes through verification before they can sell." },
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

      {/* How it works */}
      <section className="bg-surface-canvas">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-bold tracking-[-0.015em] text-ink">How it works</h2>
          <div className="mt-6 space-y-10">
            <StepFlow title="For customers" steps={CUSTOMER_STEPS} />
            <StepFlow title="For vendors" steps={VENDOR_STEPS} />
          </div>
        </div>
      </section>

      {/* Vendor categories */}
      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 className="text-2xl font-bold tracking-[-0.015em] text-ink">What you&apos;ll find on the platform</h2>
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {VENDOR_CATEGORIES.map((category) => (
            <div
              key={category}
              className="rounded-button border border-hairline bg-surface px-4 py-3 text-center text-sm font-semibold text-ink"
            >
              {category}
            </div>
          ))}
        </div>
      </section>

      {/* Screenshots */}
      <section className="bg-surface-canvas">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-bold tracking-[-0.015em] text-ink">See it in action</h2>
          <div className="mt-6 grid gap-6 sm:grid-cols-3">
            <ScreenshotPlaceholder label="Customer app" />
            <ScreenshotPlaceholder label="Vendor app" />
            <ScreenshotPlaceholder label="Vendor Portal" />
          </div>
        </div>
      </section>

      {/* Testimonials */}
      <section className="mx-auto max-w-6xl px-4 py-16 text-center sm:px-6">
        <h2 className="text-2xl font-bold tracking-[-0.015em] text-ink">What people are saying</h2>
        <p className="mt-3 text-sm text-ink-tertiary">Coming soon.</p>
      </section>
    </>
  );
}
