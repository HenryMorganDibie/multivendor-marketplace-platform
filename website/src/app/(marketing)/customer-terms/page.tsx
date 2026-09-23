import type { Metadata } from "next";
import LegalPage from "@/components/LegalPage";
import { getPublishedSiteContent } from "@/lib/siteContent";
import { SiteContentSectionContent } from "@/lib/types";

export const metadata: Metadata = {
  title: "Customer Agreement",
  description: "The terms that govern buying on Platform.",
  alternates: { canonical: "/customer-terms" },
};

const FALLBACK: SiteContentSectionContent = {
  nodes: [
    { type: "paragraph", text: "This page will contain Platform's Customer Agreement once legal copy is provided and published through the CMS." },
  ],
};

export default async function CustomerTermsPage() {
  const sections = await getPublishedSiteContent();
  return <LegalPage sections={sections} sectionId="customer-terms" fallback={FALLBACK} title="Customer Agreement" />;
}
