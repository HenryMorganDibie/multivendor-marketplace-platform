import type { Metadata } from "next";
import LegalPage from "@/components/LegalPage";
import { getPublishedSiteContent } from "@/lib/siteContent";
import { SiteContentSectionContent } from "@/lib/types";

export const metadata: Metadata = {
  title: "Customer Terms",
  description: "The terms that govern buying on the platform.",
  alternates: { canonical: "/customer-terms" },
};

const FALLBACK: SiteContentSectionContent = {
  nodes: [
    { type: "paragraph", text: "This page will contain the platform's Customer Terms once legal copy is provided and published through the CMS." },
  ],
};

export default async function CustomerTermsPage() {
  const sections = await getPublishedSiteContent();
  return <LegalPage sections={sections} sectionId="customer-terms" fallback={FALLBACK} title="Customer Terms" />;
}
