import type { Metadata } from "next";
import Link from "next/link";
import FeatureCarousel from "@/components/FeatureCarousel";
import {
  MessageCircle,
  Eye,
  BadgeCheck,
  ShieldCheck,
  Compass,
  Search,
  Store,
  ClipboardList,
  Receipt,
  Star,
  UtensilsCrossed,
  Shirt,
  Sparkles,
  Smartphone,
  SlidersHorizontal,
  Pencil,
  Send,
} from "lucide-react";

export const metadata: Metadata = {
  title: "Platform: The Marketplace Built for Direct Trade",
  description:
    "Browse vendors, chat directly, order, and pay, all in one marketplace built for how people actually buy and sell.",
  alternates: { canonical: "/" },
};

const TRUST_ROW = [
  { icon: MessageCircle, label: "Chat before you buy" },
  { icon: Eye, label: "No guessing games" },
  { icon: BadgeCheck, label: "Verified vendors" },
  { icon: ShieldCheck, label: "Built-in trust" },
];

const CUSTOMER_FEATURES = [
  {
    icon: Compass,
    title: "Discover vendors",
    body: "Browse businesses by category, location, and what's available around you.",
    visual: "discover" as const,
  },
  {
    icon: Search,
    title: "Search with ease",
    body: "Find vendors and products directly, without scrolling through endless feeds.",
    visual: "search" as const,
  },
  {
    icon: Store,
    title: "Explore storefronts",
    body: "See what a vendor offers, their business details, and customer reviews.",
    visual: "storefront" as const,
  },
];

const VENDOR_FEATURES = [
  {
    icon: ClipboardList,
    title: "Every order, in one place",
    body: "Manage marketplace orders and orders you record from outside Platform, side by side.",
    visual: "orders" as const,
  },
  {
    icon: Receipt,
    title: "Invoice without leaving Platform",
    body: "Create, brand and send invoices from the same place you manage everything else.",
    visual: "invoice" as const,
  },
  {
    icon: Store,
    title: "A storefront that's actually yours",
    body: "Customers can discover, explore and contact you, all in one place.",
    visual: "vendorStorefront" as const,
  },
];

function CategoryPill({ label, active }: { label: string; active?: boolean }) {
  return (
    <span
      className={
        active
          ? "rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-white"
          : "rounded-full border border-hairline bg-white px-3 py-1.5 text-xs font-semibold text-ink-secondary"
      }
    >
      {label}
    </span>
  );
}

function VendorRow({ initials, name, meta }: { initials: string; name: string; meta: string }) {
  return (
    <div className="flex items-center gap-3 rounded-card border border-hairline bg-white p-3 shadow-soft">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-light text-xs font-bold text-brand">
        {initials}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-bold text-ink">{name}</p>
        <p className="truncate text-xs text-ink-secondary">{meta}</p>
      </div>
    </div>
  );
}

/** Stylized phone frame, not a literal screenshot -- no app-capture asset exists yet. */
function DiscoveryMock() {
  return (
    <div className="mx-auto w-full max-w-[300px] rounded-card-lg border border-hairline bg-white p-4 shadow-soft-md">
      <div className="rounded-button border border-hairline bg-surface-canvas px-3 py-2.5 text-sm text-ink-tertiary">
        Search vendors, products
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <CategoryPill label="Food & Catering" active />
        <CategoryPill label="Fashion" />
        <CategoryPill label="Beauty" />
      </div>
      <p className="mt-4 text-[11px] font-bold uppercase tracking-wide text-ink-tertiary">Popular near you</p>
      <div className="mt-2 space-y-2">
        <VendorRow initials="SR" name="Spicy Rest" meta="4.8 · African Cuisine, Ikeja" />
        <VendorRow initials="ZE" name="Zara Electronics" meta="4.7 · Repairs & parts" />
      </div>
    </div>
  );
}

function FeatureRow({
  eyebrow,
  icon: Icon,
  title,
  body,
  reverse,
  visual,
}: {
  eyebrow?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  body: string;
  reverse?: boolean;
  visual: React.ReactNode;
}) {
  return (
    <div className={`grid items-center gap-8 sm:grid-cols-2 sm:gap-12 ${reverse ? "sm:[&>*:first-child]:order-2" : ""}`}>
      <div>{visual}</div>
      <div>
        {eyebrow ? (
          <p className="text-xs font-bold uppercase tracking-wide text-brand">{eyebrow}</p>
        ) : null}
        <div className="mt-2 flex h-10 w-10 items-center justify-center rounded-full bg-brand-light">
          <Icon size={18} className="text-brand" />
        </div>
        <h3 className="mt-3 text-xl font-bold tracking-[-0.01em] text-ink">{title}</h3>
        <p className="mt-2 text-ink-secondary">{body}</p>
      </div>
    </div>
  );
}

/** Category grid, matching "Browse businesses by category" from the app's own discover screen. */
function DiscoverMock() {
  const categories = [
    { icon: UtensilsCrossed, label: "Food & Catering" },
    { icon: Shirt, label: "Fashion" },
    { icon: Sparkles, label: "Beauty" },
    { icon: Smartphone, label: "Electronics" },
  ];
  return (
    <div className="mx-auto w-full max-w-[300px] rounded-card-lg border border-hairline bg-white p-4 shadow-soft-md">
      <p className="text-[11px] font-bold uppercase tracking-wide text-ink-tertiary">Browse by category</p>
      <div className="mt-3 grid grid-cols-2 gap-2.5">
        {categories.map(({ icon: Icon, label }) => (
          <div key={label} className="rounded-button border border-hairline bg-surface-canvas px-3 py-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white shadow-soft">
              <Icon size={15} className="text-brand" />
            </div>
            <p className="mt-2 text-xs font-semibold text-ink">{label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Search-in-progress state, matching "Find vendors and products directly." */
function SearchMock() {
  const results = [
    { initials: "ZE", name: "Zara Electronics", meta: "Repairs & parts · Ikeja" },
    { initials: "TB", name: "TechBay Store", meta: "Phones & accessories" },
  ];
  return (
    <div className="mx-auto w-full max-w-[300px] rounded-card-lg border border-hairline bg-white p-4 shadow-soft-md">
      <div className="flex items-center gap-2 rounded-button border border-brand bg-white px-3 py-2.5 shadow-soft">
        <Search size={16} className="shrink-0 text-brand" />
        <span className="text-sm text-ink">phone repair</span>
        <SlidersHorizontal size={14} className="ml-auto shrink-0 text-ink-tertiary" />
      </div>
      <p className="mt-3 text-[11px] font-bold uppercase tracking-wide text-ink-tertiary">2 results</p>
      <div className="mt-2 space-y-2">
        {results.map((r) => (
          <VendorRow key={r.name} initials={r.initials} name={r.name} meta={r.meta} />
        ))}
      </div>
    </div>
  );
}

/** Single storefront preview, matching "See what a vendor offers ... and customer reviews." */
function StorefrontMock() {
  return (
    <div className="mx-auto w-full max-w-[300px] overflow-hidden rounded-card-lg border border-hairline bg-white shadow-soft-md">
      <div className="h-16 bg-brand-light" />
      <div className="px-4 pb-4">
        <div className="-mt-6 flex h-12 w-12 items-center justify-center rounded-full border-4 border-white bg-brand text-sm font-bold text-white shadow-soft">
          SR
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <p className="text-sm font-bold text-ink">Spicy Rest</p>
          <BadgeCheck size={15} className="text-brand" />
        </div>
        <div className="mt-1 flex items-center gap-1 text-xs text-ink-secondary">
          <Star size={12} className="fill-brand text-brand" />
          4.8 · African Cuisine · Ikeja
        </div>
        <div className="mt-3 grid grid-cols-3 gap-1.5">
          <div className="h-12 rounded-button bg-surface-canvas" />
          <div className="h-12 rounded-button bg-surface-canvas" />
          <div className="h-12 rounded-button bg-surface-canvas" />
        </div>
      </div>
    </div>
  );
}

/** Order list mixing marketplace and manually-recorded orders, matching "side by side." */
function OrdersMock() {
  const rows = [
    { name: "Amaka O.", meta: "2x Jollof Rice", status: "New", tag: null },
    { name: "David E.", meta: "Chicken Combo", status: "In progress", tag: null },
    { name: "Walk-in customer", meta: "Recorded manually", status: "Completed", tag: "Manual" },
  ];
  return (
    <div className="mx-auto w-full max-w-[300px] rounded-card-lg border border-hairline bg-white p-4 shadow-soft-md">
      <p className="text-[11px] font-bold uppercase tracking-wide text-ink-tertiary">Orders</p>
      <div className="mt-3 space-y-2">
        {rows.map((row) => (
          <div key={row.name} className="rounded-button border border-hairline px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-bold text-ink">{row.name}</p>
              {row.tag ? (
                <span className="shrink-0 rounded-full border border-dashed border-hairline-strong px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-ink-tertiary">
                  {row.tag}
                </span>
              ) : null}
            </div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <p className="truncate text-xs text-ink-secondary">{row.meta}</p>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  row.status === "New"
                    ? "bg-brand-light text-brand"
                    : row.status === "Completed"
                      ? "bg-surface-canvas text-ink-secondary"
                      : "bg-ink text-white"
                }`}
              >
                {row.status}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Branded invoice preview, matching "Create, brand and send invoices." */
function InvoiceMock() {
  const items = [
    { label: "2x Jollof Rice", price: "10,000" },
    { label: "Delivery fee", price: "1,500" },
  ];
  return (
    <div className="mx-auto w-full max-w-[300px] rounded-card-lg border border-hairline bg-white p-4 shadow-soft-md">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-light text-xs font-bold text-brand">
            SR
          </span>
          <div>
            <p className="text-sm font-bold text-ink">Spicy Rest</p>
            <p className="text-[10px] text-ink-tertiary">Invoice #0417</p>
          </div>
        </div>
        <span className="flex items-center gap-1 rounded-full bg-brand-light px-2 py-0.5 text-[10px] font-semibold text-brand">
          <Send size={10} /> Sent
        </span>
      </div>
      <div className="mt-4 space-y-2 border-t border-dashed border-hairline pt-3">
        {items.map((item) => (
          <div key={item.label} className="flex items-center justify-between text-xs text-ink-secondary">
            <span>{item.label}</span>
            <span>{item.price}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-hairline pt-3">
        <span className="text-xs font-bold text-ink">Total</span>
        <span className="text-sm font-bold text-ink">{"₦"}11,500</span>
      </div>
    </div>
  );
}

/** Storefront from the vendor's own management view, matching "actually yours" -- edit affordance
 * and performance stats, distinct from the customer-facing StorefrontMock above. */
function VendorStorefrontMock() {
  return (
    <div className="mx-auto w-full max-w-[300px] overflow-hidden rounded-card-lg border border-hairline bg-white shadow-soft-md">
      <div className="relative h-16 bg-brand-light">
        <div className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full bg-white shadow-soft">
          <Pencil size={12} className="text-brand" />
        </div>
      </div>
      <div className="px-4 pb-4">
        <div className="-mt-6 flex h-12 w-12 items-center justify-center rounded-full border-4 border-white bg-brand text-sm font-bold text-white shadow-soft">
          SR
        </div>
        <p className="mt-2 text-sm font-bold text-ink">Spicy Rest</p>
        <p className="text-xs text-ink-secondary">Your storefront</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-button bg-surface-canvas px-3 py-2">
            <p className="text-sm font-bold text-ink">312</p>
            <p className="text-[10px] text-ink-tertiary">Profile views</p>
          </div>
          <div className="rounded-button bg-surface-canvas px-3 py-2">
            <p className="text-sm font-bold text-ink">48</p>
            <p className="text-[10px] text-ink-tertiary">Orders this month</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatMock() {
  return (
    <div className="mx-auto w-full max-w-sm rounded-card-lg border border-hairline bg-white shadow-soft-md">
      <div className="flex items-center gap-2.5 border-b border-hairline px-4 py-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-light text-xs font-bold text-brand">
          SR
        </span>
        <div>
          <p className="text-sm font-bold text-ink">Spicy Rest</p>
          <p className="text-xs text-ink-tertiary">Active now</p>
        </div>
      </div>
      <div className="space-y-3 px-4 py-4">
        <div className="ml-auto max-w-[80%]">
          <p className="mb-1 text-right text-[11px] font-semibold text-ink-tertiary">You</p>
          <div className="rounded-2xl rounded-br-sm bg-brand px-3.5 py-2 text-sm text-white">
            Hi, do you have jollof rice available for delivery?
          </div>
        </div>
        <div className="flex max-w-[80%] items-end gap-1.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-light text-[9px] font-bold text-brand">
            SR
          </span>
          <div>
            <p className="mb-1 text-[11px] font-semibold text-ink-tertiary">Spicy Rest</p>
            <div className="rounded-2xl rounded-bl-sm bg-surface-canvas px-3.5 py-2 text-sm text-ink">
              Yes, we do! How many plates would you like?
            </div>
          </div>
        </div>
        <div className="ml-auto max-w-[80%]">
          <div className="rounded-2xl rounded-br-sm bg-brand px-3.5 py-2 text-sm text-white">
            I&apos;ll take 2 plates please.
          </div>
        </div>
        <div className="flex max-w-[80%] items-end gap-1.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-light text-[9px] font-bold text-brand">
            SR
          </span>
          <div className="rounded-2xl rounded-bl-sm bg-surface-canvas px-3.5 py-2 text-sm text-ink">
            Great! That&apos;ll be 5,000. How&apos;d you like to pay?
          </div>
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Organization",
            name: "Platform",
            url: process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.example.com",
          }),
        }}
      />

      {/* Hero */}
      <section className="bg-white">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 sm:px-6 sm:py-20 lg:grid-cols-2 lg:gap-16">
          <div>
            <h1 className="text-4xl font-bold tracking-[-0.02em] text-ink sm:text-5xl">
              Talk to the vendor.
              <br />
              Then buy with confidence.
            </h1>
            <p className="mt-4 max-w-lg text-ink-secondary">
              Find vendors, ask real questions before you commit, and keep every order in one place. For vendors,
              Platform brings your storefront, customers, and day-to-day business together.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/customers"
                className="rounded-button bg-brand px-6 py-3 text-sm font-semibold text-white shadow-soft-md transition hover:bg-brand-dark"
              >
                Explore Platform
              </Link>
              <Link
                href="/vendors"
                className="rounded-button border border-hairline-strong bg-white px-6 py-3 text-sm font-semibold text-ink transition hover:border-brand hover:text-brand"
              >
                Become a Vendor
              </Link>
            </div>
            <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3">
              {TRUST_ROW.map(({ icon: Icon, label }) => (
                <div key={label} className="flex items-center gap-1.5 text-xs font-semibold text-ink-secondary">
                  <Icon size={14} className="text-brand" />
                  {label}
                </div>
              ))}
            </div>
          </div>
          <DiscoveryMock />
        </div>
      </section>

      {/* For customers */}
      <section id="for-customers" className="scroll-mt-20 bg-surface-canvas">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <p className="text-center text-xs font-bold uppercase tracking-wide text-brand">For customers</p>
          <h2 className="mt-2 text-center text-3xl font-bold tracking-[-0.015em] text-ink">
            Find what you&apos;re looking for. Faster.
          </h2>
          <div className="mt-12 space-y-14">
            {CUSTOMER_FEATURES.map((feature, i) => (
              <FeatureRow
                key={feature.title}
                icon={feature.icon}
                title={feature.title}
                body={feature.body}
                reverse={i % 2 === 1}
                visual={
                  feature.visual === "discover" ? (
                    <DiscoverMock />
                  ) : feature.visual === "search" ? (
                    <SearchMock />
                  ) : (
                    <StorefrontMock />
                  )
                }
              />
            ))}
          </div>
        </div>
      </section>

      {/* Direct chat */}
      <section id="chat" className="scroll-mt-20 bg-white">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:gap-16">
          <ChatMock />
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-brand">Direct chat</p>
            <h2 className="mt-2 text-2xl font-bold tracking-[-0.015em] text-ink sm:text-3xl">
              Questions? Ask the vendor directly.
            </h2>
            <p className="mt-3 text-ink-secondary">
              Keep the conversation close to the order. Chat with vendors before you buy, while your order is in
              progress, or whenever you need an update.
            </p>
            <div className="mt-4 flex items-start gap-2 text-sm font-medium text-ink">
              <BadgeCheck size={18} className="mt-0.5 shrink-0 text-brand" />
              No searching through old DMs to remember who you ordered from.
            </div>
          </div>
        </div>
      </section>

      {/* Split CTA */}
      <section className="bg-ink">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-center text-2xl font-bold tracking-[-0.015em] text-white sm:text-3xl">
            Built for both sides of the marketplace.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-center text-white/70">
            Customers get an easier way to find and buy. Vendors get the tools to turn that discovery into business.
          </p>
          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            <Link
              href="/customers"
              className="group rounded-card-lg border border-white/10 bg-white/5 p-6 transition hover:border-brand hover:bg-white/10"
            >
              <p className="text-lg font-bold text-white">I&apos;m a customer</p>
              <p className="mt-1.5 text-sm text-white/70">Discover vendors, chat, and manage your orders.</p>
              <p className="mt-4 text-sm font-semibold text-brand">Explore customer features &rarr;</p>
            </Link>
            <Link
              href="/vendors"
              className="group rounded-card-lg border border-white/10 bg-white/5 p-6 transition hover:border-brand hover:bg-white/10"
            >
              <p className="text-lg font-bold text-white">I run a business</p>
              <p className="mt-1.5 text-sm text-white/70">Build your storefront, manage orders, grow.</p>
              <p className="mt-4 text-sm font-semibold text-brand">See vendor features &rarr;</p>
            </Link>
          </div>
        </div>
      </section>

      {/* For vendors */}
      <section id="for-vendors" className="scroll-mt-20 bg-surface-canvas">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <p className="text-center text-xs font-bold uppercase tracking-wide text-brand">For vendors</p>
          <h2 className="mt-2 text-center text-3xl font-bold tracking-[-0.015em] text-ink">
            Your business deserves more than a social media profile.
          </h2>
          <div className="mt-12 space-y-14">
            {VENDOR_FEATURES.map((feature, i) => (
              <FeatureRow
                key={feature.title}
                icon={feature.icon}
                title={feature.title}
                body={feature.body}
                reverse={i % 2 === 1}
                visual={
                  feature.visual === "orders" ? (
                    <OrdersMock />
                  ) : feature.visual === "invoice" ? (
                    <InvoiceMock />
                  ) : (
                    <VendorStorefrontMock />
                  )
                }
              />
            ))}
          </div>
        </div>
      </section>

      {/* More ways Platform helps */}
      <section id="more-features" className="scroll-mt-20 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-center text-2xl font-bold tracking-[-0.015em] text-ink sm:text-3xl">
            More ways Platform helps you
          </h2>
          <div className="mt-10">
            <FeatureCarousel />
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="bg-brand">
        <div className="mx-auto max-w-6xl px-4 py-16 text-center sm:px-6">
          <h2 className="text-2xl font-bold tracking-[-0.015em] text-white sm:text-3xl">
            Find it. Sell it. Manage it.
            <br />
            All on Platform.
          </h2>
          <div className="mt-6 flex justify-center gap-3">
            <Link
              href="/customers"
              className="rounded-button bg-white px-6 py-3 text-sm font-semibold text-brand shadow-soft-md transition hover:bg-white/90"
            >
              Explore Platform
            </Link>
            <Link
              href="/vendors"
              className="rounded-button border border-white/40 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              Become a Vendor
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
