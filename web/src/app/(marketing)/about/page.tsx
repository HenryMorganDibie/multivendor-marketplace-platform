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

    { type: "heading", level: 2, text: "Mission" },
    {
      type: "paragraph",
      text: "the platform exists to connect customers and vendors directly, without the friction of traditional marketplaces getting in the way of a simple transaction.",
    },

    { type: "heading", level: 2, text: "The problem" },
    {
      type: "paragraph",
      text: "Buying and selling online is fragmented — customers can't ask a question before they buy, vendors lose leads to platforms that don't let them talk to their own customers, and local businesses get buried under listings from anywhere in the world.",
    },

    { type: "heading", level: 2, text: "Our solution" },
    {
      type: "paragraph",
      text: "the platform brings it together in one place: verified local vendors, direct chat before every order, and a storefront and business tools vendors actually own.",
    },

    { type: "heading", level: 2, text: "Our values" },
    {
      type: "bulletList",
      items: ["Trust", "Transparency", "Local Business", "Communication", "Innovation"],
    },

    { type: "heading", level: 2, text: "Roadmap" },
    {
      type: "paragraph",
      text: "We're launching country by country, with more payment options and new tools for vendors as we grow. Join the waitlist on the Pricing page to hear when the platform reaches your country.",
    },
  ],
};

export default async function AboutPage() {
  const sections = await getPublishedSiteContent();
  const { content } = sectionOrFallback(sections, "about", FALLBACK);
  return <MarketingSection content={content} />;
}
