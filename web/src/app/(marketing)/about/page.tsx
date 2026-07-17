import type { Metadata } from "next";
import MarketingSection from "@/components/MarketingSection";
import { getPublishedSiteContent, sectionOrFallback } from "@/lib/siteContent";
import { SiteContentSectionContent } from "@/lib/types";

export const metadata: Metadata = {
  title: "About the platform",
  description: "the platform's story and mission.",
  alternates: { canonical: "/about" },
};

const FALLBACK: SiteContentSectionContent = {
  nodes: [
    { type: "heading", level: 1, text: "About the platform" },
    {
      type: "paragraph",
      text: "the platform was built to connect vendors and customers directly, without the friction of traditional marketplaces getting in the way of a simple transaction.",
    },
  ],
};

export default async function AboutPage() {
  const sections = await getPublishedSiteContent();
  const { content } = sectionOrFallback(sections, "about", FALLBACK);
  return <MarketingSection content={content} />;
}
