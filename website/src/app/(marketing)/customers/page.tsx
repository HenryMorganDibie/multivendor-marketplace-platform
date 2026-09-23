import type { Metadata } from "next";
import { APP_SCREENSHOTS_AVAILABLE } from "@/lib/appScreenshots";
import RichText from "@/components/RichText";
import AccordionItem from "@/components/Accordion";
import { AppStoreBadge, GooglePlayBadge } from "@/components/AppBadges";
import { getPublishedSiteContent, sectionOrFallback } from "@/lib/siteContent";
import { SiteContentSectionContent } from "@/lib/types";
import { Compass, Search, MessageCircle, Truck, Star, Heart, Bell, CheckCircle2 } from "lucide-react";

export const metadata: Metadata = {
  title: "Shop on Platform",
  description: "Browse verified vendors, chat directly, and order with confidence on Platform.",
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

const BENEFITS = [
  { icon: Compass, label: "Browse vendors" },
  { icon: Search, label: "Search" },
  { icon: MessageCircle, label: "Chat before ordering" },
  { icon: Truck, label: "Track orders" },
  { icon: Star, label: "Reviews" },
  { icon: Heart, label: "Favorites" },
  { icon: Bell, label: "Notifications" },
];

const JOURNEY = [
  { label: "Browse", body: "Find verified vendors near you, by category or search." },
  { label: "Chat", body: "Ask questions directly before you commit to buying." },
  { label: "Order", body: "Place your order and pay with what's available in your country." },
  { label: "Receive", body: "Track it through to pickup or delivery." },
];

const CUSTOMER_SCREENSHOTS = ["Home", "Vendor Store", "Chat", "Order", "Tracking", "Reviews"];

const CUSTOMER_FAQ = [
  { q: "Can I contact vendors?", a: "Yes. You can message a vendor directly to ask questions before you commit to buying anything." },
  { q: "How do I order?", a: "Browse a vendor's catalog, add what you want, and check out with the payment method available in your country." },
  { q: "How do I pay?", a: "Platform supports the payment methods available in your country, selected automatically at checkout." },
  { q: "Can I cancel?", a: "Order cancellation depends on where it is in the vendor's fulfillment process. Message the vendor directly to ask." },
];

function ScreenshotPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex aspect-[9/16] flex-col items-center justify-center gap-2 rounded-card-lg border-2 border-dashed border-hairline-strong bg-surface-canvas text-center">
      <span className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">Coming soon</span>
      <span className="px-4 text-sm font-medium text-ink-secondary">{label}</span>
    </div>
  );
}

/** Order-tracking timeline, giving the hero copy a visual anchor -- matches the "Track orders" benefit. */
function OrderTrackingMock() {
  const steps = [
    { label: "Order placed", done: true },
    { label: "Accepted by vendor", done: true },
    { label: "Ready for pickup", done: false, active: true },
    { label: "Picked up", done: false },
  ];
  return (
    <div className="mx-auto w-full max-w-[300px] rounded-card-lg border border-hairline bg-white p-5 shadow-soft-md">
      <div className="flex items-center gap-2.5 border-b border-hairline pb-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-light text-xs font-bold text-brand">
          SR
        </span>
        <div>
          <p className="text-sm font-bold text-ink">Spicy Rest</p>
          <p className="text-[10px] text-ink-tertiary">Order #1042</p>
        </div>
      </div>
      <div className="mt-4 space-y-4">
        {steps.map((step, i) => (
          <div key={step.label} className="flex items-center gap-3">
            <div className="flex flex-col items-center self-stretch">
              {step.done ? (
                <CheckCircle2 size={18} className="shrink-0 text-brand" />
              ) : (
                <span
                  className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 ${
                    step.active ? "border-brand" : "border-hairline-strong"
                  }`}
                >
                  {step.active ? <span className="h-1.5 w-1.5 rounded-full bg-brand" /> : null}
                </span>
              )}
              {i < steps.length - 1 ? (
                <span className={`mt-1 h-6 w-0.5 ${step.done ? "bg-brand" : "bg-hairline-strong"}`} />
              ) : null}
            </div>
            <p className={`text-sm ${step.active ? "font-bold text-ink" : step.done ? "text-ink-secondary" : "text-ink-tertiary"}`}>
              {step.label}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default async function CustomersPage() {
  const sections = await getPublishedSiteContent();
  const { content } = sectionOrFallback(sections, "customers", FALLBACK);

  return (
    <>
      <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:gap-16">
        <div>
          <RichText content={content} />
          <div className="mt-6 flex flex-wrap gap-3">
            <AppStoreBadge href="https://apps.apple.com/" />
            <GooglePlayBadge href="https://play.google.com/store" />
          </div>
        </div>
        <OrderTrackingMock />
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

      {APP_SCREENSHOTS_AVAILABLE ? (
        <section className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
          <h2 className="text-xl font-bold tracking-[-0.015em] text-ink">See the Customer experience</h2>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
            {CUSTOMER_SCREENSHOTS.map((label) => (
              <ScreenshotPlaceholder key={label} label={label} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="mx-auto max-w-4xl px-4 pb-16 sm:px-6">
        <h2 className="text-xl font-bold tracking-[-0.015em] text-ink">FAQ</h2>
        <div className="mt-2">
          {CUSTOMER_FAQ.map((item) => (
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
