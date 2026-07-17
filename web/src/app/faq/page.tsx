import type { Metadata } from "next";
import MarketingSection from "@/components/MarketingSection";
import { getPublishedSiteContent, sectionOrFallback } from "@/lib/siteContent";
import { SiteContentSectionContent } from "@/lib/types";

export const metadata: Metadata = {
  title: "FAQ",
  description: "Common questions about buying and selling on the platform.",
  alternates: { canonical: "/faq" },
};

const FALLBACK: SiteContentSectionContent = {
  nodes: [
    { type: "heading", level: 1, text: "Frequently Asked Questions" },
    { type: "heading", level: 3, text: "How do I become a vendor?" },
    { type: "paragraph", text: "Download the the platform mobile app and register as a vendor — registration is mobile-only for now." },
    { type: "heading", level: 3, text: "How do I pay?" },
    { type: "paragraph", text: "the platform supports the payment methods available in your country, selected automatically at checkout." },
    { type: "heading", level: 3, text: "Is my payment information safe?" },
    { type: "paragraph", text: "Payments are processed by our payment providers directly — the platform never stores your card details." },
  ],
};

export default async function FaqPage() {
  const sections = await getPublishedSiteContent();
  const { content } = sectionOrFallback(sections, "faq", FALLBACK);
  return <MarketingSection content={content} />;
}
