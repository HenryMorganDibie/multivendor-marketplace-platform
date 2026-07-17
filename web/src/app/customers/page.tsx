import type { Metadata } from "next";
import MarketingSection from "@/components/MarketingSection";
import { getPublishedSiteContent, sectionOrFallback } from "@/lib/siteContent";
import { SiteContentSectionContent } from "@/lib/types";

export const metadata: Metadata = {
  title: "Shop on the platform",
  description: "Browse verified vendors, chat directly, and order with confidence on the platform.",
  alternates: { canonical: "/customers" },
};

const FALLBACK: SiteContentSectionContent = {
  nodes: [
    { type: "heading", level: 1, text: "Shop from vendors you can actually talk to" },
    {
      type: "paragraph",
      text: "Browse verified vendors near you, ask questions before you buy, and track every order from checkout to pickup.",
    },
  ],
};

export default async function CustomersPage() {
  const sections = await getPublishedSiteContent();
  const { content } = sectionOrFallback(sections, "customers", FALLBACK);

  return (
    <MarketingSection content={content}>
      <div className="mt-10 flex flex-wrap gap-4">
        <a href="https://apps.apple.com/" className="rounded-full bg-black px-6 py-3 text-sm font-semibold text-white hover:bg-gray-800">
          Download on the App Store
        </a>
        <a href="https://play.google.com/store" className="rounded-full bg-black px-6 py-3 text-sm font-semibold text-white hover:bg-gray-800">
          Get it on Google Play
        </a>
      </div>
    </MarketingSection>
  );
}
