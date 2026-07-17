import type { Metadata } from "next";
import LegalPage from "@/components/LegalPage";
import { getPublishedSiteContent } from "@/lib/siteContent";
import { SiteContentSectionContent } from "@/lib/types";

export const metadata: Metadata = {
  title: "Acceptable Use Policy",
  description: "What is and isn't allowed on the platform.",
  alternates: { canonical: "/acceptable-use-policy" },
};

const FALLBACK: SiteContentSectionContent = {
  nodes: [
    { type: "paragraph", text: "This page will contain the platform's Acceptable Use Policy once legal copy is provided and published through the CMS." },
  ],
};

export default async function AcceptableUsePolicyPage() {
  const sections = await getPublishedSiteContent();
  return <LegalPage sections={sections} sectionId="acceptable-use-policy" fallback={FALLBACK} title="Acceptable Use Policy" />;
}
