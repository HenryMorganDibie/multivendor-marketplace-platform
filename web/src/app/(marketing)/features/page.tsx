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
    { type: "heading", level: 1, text: "Everything the platform can do" },

    { type: "heading", level: 2, text: "Customers" },
    {
      type: "bulletList",
      items: [
        "Browse vendors",
        "Search",
        "Chat",
        "Favorites",
        "Notifications",
        "Reviews",
        "Order tracking",
        "Order history",
      ],
    },

    { type: "heading", level: 2, text: "Vendors" },
    {
      type: "bulletList",
      items: [
        "Verified storefront",
        "Product catalog",
        "Customer chat",
        "Marketplace orders",
        "External orders",
        "Invoices",
        "Vendor Portal",
        "Business profile",
        "Notifications",
        "Subscription management",
      ],
    },

    { type: "heading", level: 2, text: "Platform" },
    {
      type: "bulletList",
      items: [
        "Multi-country support",
        "Country-specific pricing",
        "Cloud sync",
        "Spam protection",
        "Secure authentication",
      ],
    },
  ],
};

export default async function FeaturesPage() {
  const sections = await getPublishedSiteContent();
  const { content } = sectionOrFallback(sections, "features", FALLBACK);
  return <MarketingSection content={content} />;
}
