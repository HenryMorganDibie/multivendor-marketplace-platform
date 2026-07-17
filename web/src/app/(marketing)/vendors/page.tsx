import type { Metadata } from "next";
import RichText from "@/components/RichText";
import { AppStoreBadge, GooglePlayBadge } from "@/components/AppBadges";
import { getPublishedSiteContent, sectionOrFallback } from "@/lib/siteContent";
import { SiteContentSectionContent } from "@/lib/types";

export const metadata: Metadata = {
  title: "Sell on the platform",
  description: "Become a the platform vendor — reach customers directly, chat, invoice, and grow with a plan that fits your business.",
  alternates: { canonical: "/vendors" },
};

const FALLBACK: SiteContentSectionContent = {
  nodes: [
    { type: "heading", level: 1, text: "Sell directly to customers." },
    {
      type: "paragraph",
      text: "the platform gives your business a verified storefront, direct customer chat, and invoicing — without giving up your margin to a middleman.",
    },
  ],
};

const BENEFITS = [
  "Verified storefront",
  "Professional business profile",
  "Customer chat",
  "Marketplace orders",
  "External orders",
  "Invoices",
  "Subscription plans",
  "Vendor Portal",
];

const REGISTRATION_STEPS = [
  { label: "Download app", body: "Get the the platform app on iOS or Android." },
  { label: "Register", body: "Set up your business account and storefront." },
  { label: "Verify", body: "Submit your business documents for review." },
  { label: "Publish", body: "Once approved, your storefront goes live." },
  { label: "Start selling", body: "Chat with customers and manage orders directly." },
];

const VENDOR_SCREENSHOTS = ["Storefront", "Orders", "Chat", "Invoices", "External Orders", "Vendor Portal"];

const VENDOR_FAQ = [
  { q: "How do I register?", a: "Download the the platform mobile app and register as a vendor — registration is mobile-only for now." },
  { q: "Why verification?", a: "It's what earns your storefront the verified badge customers look for before they buy." },
  { q: "How do subscriptions work?", a: "Every vendor starts free on Basic. Paid plans unlock higher catalog limits, priority placement, and more." },
  { q: "How do invoices work?", a: "Create branded invoices for customers from the app or the Vendor Portal, gated by your plan's monthly quota." },
  { q: "What are external orders?", a: "Orders you record from outside the marketplace (phone, in-person) so they're tracked alongside everything else." },
];

function ScreenshotPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex aspect-[9/16] flex-col items-center justify-center gap-2 rounded-card-lg border-2 border-dashed border-hairline-strong bg-surface-canvas text-center">
      <span className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">Coming soon</span>
      <span className="px-4 text-sm font-medium text-ink-secondary">{label}</span>
    </div>
  );
}

export default async function VendorsPage() {
  const sections = await getPublishedSiteContent();
  const { content } = sectionOrFallback(sections, "vendors", FALLBACK);

  return (
    <>
      <section className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <RichText content={content} />
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
          <h2 className="text-xl font-bold tracking-[-0.015em] text-ink">Getting started</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {REGISTRATION_STEPS.map((step, i) => (
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
        <h2 className="text-xl font-bold tracking-[-0.015em] text-ink">See the Vendor experience</h2>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {VENDOR_SCREENSHOTS.map((label) => (
            <ScreenshotPlaceholder key={label} label={label} />
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 pb-12 sm:px-6">
        <div className="rounded-card-lg border border-brand/20 bg-brand-light p-8">
          <h2 className="text-xl font-bold tracking-[-0.01em] text-ink">Become a Vendor</h2>
          <p className="mt-2 text-sm text-ink-secondary">
            Vendor registration happens in the the platform mobile app. Download it to get started — sign up, verify your business, and start selling.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <AppStoreBadge href="https://apps.apple.com/" />
            <GooglePlayBadge href="https://play.google.com/store" />
          </div>
          <p className="mt-4 text-xs text-ink-tertiary">
            Already a vendor?{" "}
            <a href="https://vendor.the platform.com" className="font-medium text-brand hover:text-brand-dark">
              Log in to your Vendor Portal
            </a>
            .
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 pb-16 sm:px-6">
        <h2 className="text-xl font-bold tracking-[-0.015em] text-ink">FAQ</h2>
        <div className="mt-4 space-y-5">
          {VENDOR_FAQ.map((item) => (
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
