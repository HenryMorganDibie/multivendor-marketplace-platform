import type { Metadata } from "next";
import { APP_SCREENSHOTS_AVAILABLE } from "@/lib/appScreenshots";
import RichText from "@/components/RichText";
import AccordionItem from "@/components/Accordion";
import { AppStoreBadge, GooglePlayBadge } from "@/components/AppBadges";
import { getPublishedSiteContent, sectionOrFallback } from "@/lib/siteContent";
import { SiteContentSectionContent } from "@/lib/types";
import {
  BadgeCheck,
  Store,
  MessageCircle,
  ClipboardList,
  PlusCircle,
  Receipt,
  CreditCard,
  LayoutDashboard,
  TrendingUp,
  Bell,
} from "lucide-react";

export const metadata: Metadata = {
  title: "Sell on Platform",
  description: "Become a Platform vendor: reach customers directly, chat, invoice, and grow with a plan that fits your business.",
  alternates: { canonical: "/vendors" },
};

const FALLBACK: SiteContentSectionContent = {
  nodes: [
    { type: "heading", level: 1, text: "Sell directly to customers." },
    {
      type: "paragraph",
      text: "Platform gives your business a verified storefront, direct customer chat, and invoicing, without giving up your margin to a middleman.",
    },
  ],
};

const BENEFITS = [
  { icon: BadgeCheck, label: "Verified storefront" },
  { icon: Store, label: "Professional business profile" },
  { icon: MessageCircle, label: "Customer chat" },
  { icon: ClipboardList, label: "Marketplace orders" },
  { icon: PlusCircle, label: "External orders" },
  { icon: Receipt, label: "Invoices" },
  { icon: CreditCard, label: "Subscription plans" },
  { icon: LayoutDashboard, label: "Vendor Portal" },
];

const REGISTRATION_STEPS = [
  { label: "Download app", body: "Get the Platform app on iOS or Android." },
  { label: "Register", body: "Set up your business account and storefront." },
  { label: "Verify", body: "Submit your business documents for review." },
  { label: "Publish", body: "Once approved, your storefront goes live." },
  { label: "Start selling", body: "Chat with customers and manage orders directly." },
];

const VENDOR_SCREENSHOTS = ["Storefront", "Orders", "Chat", "Invoices", "External Orders", "Vendor Portal"];

const VENDOR_FAQ = [
  { q: "How do I register?", a: "Download the Platform mobile app and register as a vendor. Registration is mobile-only for now." },
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

/** Vendor dashboard snapshot, giving the hero copy a visual anchor -- matches "Vendor Portal." */
function VendorDashboardMock() {
  return (
    <div className="mx-auto w-full max-w-[300px] rounded-card-lg border border-hairline bg-white p-5 shadow-soft-md">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-light text-xs font-bold text-brand">
            SR
          </span>
          <div>
            <p className="text-sm font-bold text-ink">Spicy Rest</p>
            <p className="text-[10px] text-ink-tertiary">Vendor Portal</p>
          </div>
        </div>
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-canvas">
          <Bell size={13} className="text-ink-secondary" />
        </span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <div className="rounded-button bg-surface-canvas px-3 py-2.5">
          <div className="flex items-center gap-1 text-[10px] text-ink-tertiary">
            <TrendingUp size={11} className="text-brand" /> Revenue today
          </div>
          <p className="mt-1 text-base font-bold text-ink">{"₦"}84,000</p>
        </div>
        <div className="rounded-button bg-surface-canvas px-3 py-2.5">
          <div className="flex items-center gap-1 text-[10px] text-ink-tertiary">
            <ClipboardList size={11} className="text-brand" /> New orders
          </div>
          <p className="mt-1 text-base font-bold text-ink">6</p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 rounded-button border border-hairline px-3 py-2.5">
        <MessageCircle size={14} className="shrink-0 text-brand" />
        <p className="text-xs text-ink-secondary">3 customers waiting on a reply</p>
      </div>
    </div>
  );
}

export default async function VendorsPage() {
  const sections = await getPublishedSiteContent();
  const { content } = sectionOrFallback(sections, "vendors", FALLBACK);

  return (
    <>
      <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:gap-16">
        <RichText content={content} />
        <VendorDashboardMock />
      </section>

      <section className="mx-auto max-w-4xl px-4 pb-12 sm:px-6">
        <h2 className="text-xl font-bold tracking-[-0.015em] text-ink">What you get</h2>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {BENEFITS.map(({ icon: Icon, label }) => (
            <div key={label} className="rounded-card border border-hairline bg-surface px-4 py-4 text-center shadow-soft">
              <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-brand-light">
                <Icon size={16} className="text-brand" />
              </div>
              <p className="mt-2 text-sm font-semibold text-ink">{label}</p>
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

      {APP_SCREENSHOTS_AVAILABLE ? (
        <section className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
          <h2 className="text-xl font-bold tracking-[-0.015em] text-ink">See the Vendor experience</h2>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
            {VENDOR_SCREENSHOTS.map((label) => (
              <ScreenshotPlaceholder key={label} label={label} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="mx-auto max-w-4xl px-4 pb-12 sm:px-6">
        <div className="rounded-card-lg border border-brand/20 bg-brand-light p-8">
          <h2 className="text-xl font-bold tracking-[-0.01em] text-ink">Become a Vendor</h2>
          <p className="mt-2 text-sm text-ink-secondary">
            Vendor registration happens in the Platform mobile app. Download it to get started: sign up, verify your business, and start selling.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <AppStoreBadge href="https://apps.apple.com/" />
            <GooglePlayBadge href="https://play.google.com/store" />
          </div>
          <p className="mt-4 text-xs text-ink-tertiary">
            Already a vendor?{" "}
            <a href="https://vendor.example.com" className="font-medium text-brand hover:text-brand-dark">
              Log in to your Vendor Portal
            </a>
            .
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 pb-16 sm:px-6">
        <h2 className="text-xl font-bold tracking-[-0.015em] text-ink">FAQ</h2>
        <div className="mt-2">
          {VENDOR_FAQ.map((item) => (
            <AccordionItem key={item.q} question={item.q}>
              {item.a}
            </AccordionItem>
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
