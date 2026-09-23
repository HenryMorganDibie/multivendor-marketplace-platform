import type { Metadata } from "next";
import LegalPage from "@/components/LegalPage";
import { getPublishedSiteContent } from "@/lib/siteContent";
import { SiteContentSectionContent } from "@/lib/types";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How Platform collects, uses, and protects your information.",
  alternates: { canonical: "/privacy-policy" },
};

const FALLBACK: SiteContentSectionContent = {
  nodes: [
    { type: "paragraph", text: "This page will contain Platform's full Privacy Policy once legal copy is provided and published through the CMS." },
  ],
};

export default async function PrivacyPolicyPage() {
  const sections = await getPublishedSiteContent();
  return <LegalPage sections={sections} sectionId="privacy-policy" fallback={FALLBACK} title="Privacy Policy" />;
}
