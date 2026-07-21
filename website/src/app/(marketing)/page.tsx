import type { Metadata } from "next";
import Link from "next/link";
import RichText from "@/components/RichText";
import { AppStoreBadge, GooglePlayBadge } from "@/components/AppBadges";
import { getPublishedSiteContent, sectionOrFallback } from "@/lib/siteContent";
import { SiteContentSectionContent } from "@/lib/types";

export const metadata: Metadata = {
  title: "the platform — The Marketplace Built for Direct Trade",
  description:
    "Browse vendors, chat directly, order, and pay — all in one marketplace built for how people actually buy and sell.",
  alternates: { canonical: "/" },
};

// Hero copy per the client's content spec (2026-07-17) — CMS-editable
// (siteContent/home) once published; this is the fallback shown until then.
const FALLBACK: SiteContentSectionContent = {
  nodes: [
    { type: "heading", level: 1, text: "Buy and sell directly." },
    {
      type: "paragraph",
      text: "the platform connects customers and vendors directly. Browse verified vendors, chat before ordering, place orders, and manage your business — all in one platform.",
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

const WHY_THE PLATFORM = [
  { title: "Verified Vendors", body: "Browse trusted businesses in your area." },
  { title: "Chat Before Ordering", body: "Ask questions before placing an order." },
  { title: "Marketplace Orders", body: "Track orders from request to completion." },
  { title: "Built for Local Businesses", body: "Create a storefront and grow your business." },
];

const CUSTOMER_STEPS = [
  { label: "Browse", body: "Find verified vendors near you, by category or search." },
  { label: "Chat", body: "Ask questions directly before you commit to buying." },
  { label: "Order", body: "Place your order and pay with what's available in your country." },
  { label: "Receive", body: "Track it through to pickup or delivery." },
];

const VENDOR_STEPS = [
  { label: "Register", body: "Sign up in the mobile app." },
  { label: "Verify", body: "Submit your business documents for a verified badge." },
  { label: "Create Storefront", body: "List your catalog and set up your business profile." },
  { label: "Receive Orders", body: "Chat with customers and fulfill orders directly." },
  { label: "Grow Business", body: "Track performance and upgrade your plan as you scale." },
];

function StepFlow({ title, steps }: { title: string; steps: { label: string; body: string }[] }) {
  return (
    <div>
      <p className="text-sm font-semibold uppercase tracking-wide text-brand">{title}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {steps.map((step, i) => (
          <div key={step.label} className="relative rounded-card border border-hairline p-4 shadow-soft">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-light text-xs font-bold text-brand">
              {i + 1}
            </span>
            <p className="mt-2 font-bold tracking-[-0.01em] text-ink">{step.label}</p>
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
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <div className="max-w-2xl">
            <RichText content={content} />
            <div className="mt-6 flex flex-wrap gap-3">
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

      {/* Why the platform */}
      <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <h2 className="text-2xl font-bold tracking-[-0.015em] text-ink">Why the platform</h2>
        <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {WHY_THE PLATFORM.map((item) => (
            <div key={item.title} className="rounded-card border border-hairline p-5 shadow-soft">
              <h3 className="font-bold tracking-[-0.01em] text-ink">{item.title}</h3>
              <p className="mt-1.5 text-sm text-ink-secondary">{item.body}</p>
            </div>
          ))}
        </div>
        <div className="mt-8 text-center">
          <Link href="/features" className="text-sm font-semibold text-brand hover:text-brand-dark">
            See all features &rarr;
          </Link>
        </div>
      </section>

      {/* How it works */}
      <section className="bg-surface-canvas">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
          <h2 className="text-2xl font-bold tracking-[-0.015em] text-ink">How it works</h2>
          <div className="mt-5 space-y-8">
            <StepFlow title="Customers" steps={CUSTOMER_STEPS} />
            <StepFlow title="Vendors" steps={VENDOR_STEPS} />
          </div>
        </div>
      </section>

      {/* Vendor categories */}
      <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <h2 className="text-2xl font-bold tracking-[-0.015em] text-ink">Vendor Categories</h2>
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
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
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
          <h2 className="text-2xl font-bold tracking-[-0.015em] text-ink">App Screenshots</h2>
          <div className="mt-5 grid gap-5 sm:grid-cols-3">
            <ScreenshotPlaceholder label="Customer App" />
            <ScreenshotPlaceholder label="Vendor App" />
            <ScreenshotPlaceholder label="Vendor Portal" />
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-4 py-16 text-center sm:px-6">
        <h2 className="text-2xl font-bold tracking-[-0.015em] text-ink">Ready to start?</h2>
        <div className="mt-6 flex justify-center gap-3">
          <AppStoreBadge href="https://apps.apple.com/" />
          <GooglePlayBadge href="https://play.google.com/store" />
        </div>
      </section>
    </>
  );
}
