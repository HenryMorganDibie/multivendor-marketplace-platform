import type { Metadata } from "next";
import MarketingSection from "@/components/MarketingSection";
import { getPublishedSiteContent, sectionOrFallback } from "@/lib/siteContent";
import { SiteContentSectionContent } from "@/lib/types";

export const metadata: Metadata = {
  title: "Features",
  description: "Everything the platform gives vendors and customers — direct chat, verified vendors, and simple checkout.",
  alternates: { canonical: "/features" },
};

const FALLBACK: SiteContentSectionContent = {
  nodes: [
    { type: "heading", level: 1, text: "Features" },
    { type: "paragraph", text: "A full breakdown of what the platform offers vendors and customers." },
    { type: "heading", level: 2, text: "For customers" },
    {
      type: "bulletList",
      items: [
        "Browse vendors by category and location",
        "Message vendors directly before you buy",
        "Track orders and pickup status in real time",
        "Rate and review vendors after every order",
      ],
    },
    { type: "heading", level: 2, text: "For vendors" },
    {
      type: "bulletList",
      items: [
        "A verified storefront customers can trust",
        "Direct chat with customers, no lost leads",
        "Invoicing with your own branding",
        "Subscription plans that scale with your business",
      ],
    },
  ],
};

export default async function FeaturesPage() {
  const sections = await getPublishedSiteContent();
  const { content } = sectionOrFallback(sections, "features", FALLBACK);
  return <MarketingSection content={content} />;
}
