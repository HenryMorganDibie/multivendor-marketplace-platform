import type { Metadata } from "next";
import LegalPage from "@/components/LegalPage";
import { getPublishedSiteContent } from "@/lib/siteContent";
import { SiteContentSectionContent } from "@/lib/types";

export const metadata: Metadata = {
  title: "Vendor Agreement",
  description: "The terms that govern selling on Platform.",
  alternates: { canonical: "/vendor-terms" },
};

const FALLBACK: SiteContentSectionContent = {
  nodes: [
    { type: "paragraph", text: "This page will contain Platform's Vendor Agreement once legal copy is provided and published through the CMS." },
  ],
};

export default async function VendorTermsPage() {
  const sections = await getPublishedSiteContent();
  return <LegalPage sections={sections} sectionId="vendor-terms" fallback={FALLBACK} title="Vendor Agreement" />;
}
