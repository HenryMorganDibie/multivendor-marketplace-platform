import type { Metadata } from "next";
import LegalPage from "@/components/LegalPage";
import { getPublishedSiteContent } from "@/lib/siteContent";
import { SiteContentSectionContent } from "@/lib/types";

export const metadata: Metadata = {
  title: "Terms of Use",
  description: "The terms that govern use of Platform.",
  alternates: { canonical: "/terms-of-service" },
};

const FALLBACK: SiteContentSectionContent = {
  nodes: [
    { type: "paragraph", text: "This page will contain Platform's full Terms of Use once legal copy is provided and published through the CMS." },
  ],
};

export default async function TermsOfServicePage() {
  const sections = await getPublishedSiteContent();
  return <LegalPage sections={sections} sectionId="terms-of-service" fallback={FALLBACK} title="Terms of Use" />;
}
