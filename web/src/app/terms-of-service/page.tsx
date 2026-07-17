import type { Metadata } from "next";
import LegalPage from "@/components/LegalPage";
import { getPublishedSiteContent } from "@/lib/siteContent";
import { SiteContentSectionContent } from "@/lib/types";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms that govern use of the platform.",
  alternates: { canonical: "/terms-of-service" },
};

const FALLBACK: SiteContentSectionContent = {
  nodes: [
    { type: "heading", level: 1, text: "Terms of Service" },
    { type: "paragraph", text: "This page will contain the platform's full Terms of Service once legal copy is provided and published through the CMS." },
  ],
};

export default async function TermsOfServicePage() {
  const sections = await getPublishedSiteContent();
  return <LegalPage sections={sections} sectionId="terms-of-service" fallback={FALLBACK} title="Terms of Service" />;
}
