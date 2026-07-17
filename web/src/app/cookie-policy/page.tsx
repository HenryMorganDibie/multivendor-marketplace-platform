import type { Metadata } from "next";
import LegalPage from "@/components/LegalPage";
import { getPublishedSiteContent } from "@/lib/siteContent";
import { SiteContentSectionContent } from "@/lib/types";

export const metadata: Metadata = {
  title: "Cookie Policy",
  description: "How the platform uses cookies and similar storage.",
  alternates: { canonical: "/cookie-policy" },
};

// Default MVP assumption (Section 6.3, pending the client's explicit
// confirmation): no analytics or marketing cookies/trackers. Only
// essential storage (e.g. session/auth tokens) is used, so no consent
// banner is required. If analytics/advertising cookies are added later,
// this copy and the no-banner decision both need revisiting together.
const FALLBACK: SiteContentSectionContent = {
  nodes: [
    {
      type: "paragraph",
      text: "the platform's website uses only essential storage required for the site to function — such as keeping you signed in to the Vendor Portal. We do not use analytics or marketing cookies or trackers.",
    },
    { type: "paragraph", text: "Because no non-essential cookies are used, no cookie consent banner is shown." },
  ],
};

export default async function CookiePolicyPage() {
  const sections = await getPublishedSiteContent();
  return <LegalPage sections={sections} sectionId="cookie-policy" fallback={FALLBACK} title="Cookie Policy" />;
}
