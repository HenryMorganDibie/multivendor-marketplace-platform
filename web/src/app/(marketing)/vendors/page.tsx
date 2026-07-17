import type { Metadata } from "next";
import MarketingSection from "@/components/MarketingSection";
import { getPublishedSiteContent, sectionOrFallback } from "@/lib/siteContent";
import { SiteContentSectionContent } from "@/lib/types";

export const metadata: Metadata = {
  title: "Sell on the platform",
  description: "Become a the platform vendor — reach customers directly, chat, invoice, and grow with a plan that fits your business.",
  alternates: { canonical: "/vendors" },
};

const FALLBACK: SiteContentSectionContent = {
  nodes: [
    { type: "heading", level: 1, text: "Sell directly to customers who are ready to buy" },
    {
      type: "paragraph",
      text: "the platform gives your business a verified storefront, direct customer chat, and invoicing — without giving up your margin to a middleman.",
    },
  ],
};

export default async function VendorsPage() {
  const sections = await getPublishedSiteContent();
  const { content } = sectionOrFallback(sections, "vendors", FALLBACK);

  return (
    <MarketingSection content={content}>
      <div className="mt-10 rounded-2xl border border-brand/30 bg-brand-light p-8 dark:bg-gray-900">
        <h2 className="text-xl font-semibold">Become a Vendor</h2>
        <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
          Vendor registration happens in the the platform mobile app. Download it to get started — sign up, verify your business, and start selling.
        </p>
        <div className="mt-6 flex flex-wrap gap-4">
          <a
            href="https://apps.apple.com/"
            className="rounded-full bg-black px-6 py-3 text-sm font-semibold text-white hover:bg-gray-800"
          >
            Download on the App Store
          </a>
          <a
            href="https://play.google.com/store"
            className="rounded-full bg-black px-6 py-3 text-sm font-semibold text-white hover:bg-gray-800"
          >
            Get it on Google Play
          </a>
        </div>
        <p className="mt-4 text-xs text-gray-500 dark:text-gray-500">
          Already a vendor?{" "}
          <a href="https://vendor.the platform.com" className="font-medium text-brand hover:text-brand-dark">
            Log in to your Vendor Portal
          </a>
          .
        </p>
      </div>
    </MarketingSection>
  );
}
