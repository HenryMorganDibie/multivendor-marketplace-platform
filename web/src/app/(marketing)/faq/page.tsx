import type { Metadata } from "next";
import MarketingSection from "@/components/MarketingSection";
import { getPublishedSiteContent, sectionOrFallback } from "@/lib/siteContent";
import { SiteContentSectionContent } from "@/lib/types";

export const metadata: Metadata = {
  title: "FAQ",
  description: "Common questions about buying and selling on the platform.",
  alternates: { canonical: "/faq" },
};

// Answers describe actual built behavior (backend-verified this session),
// not aspirational copy — safe to publish as-is, though the client may still
// want to adjust tone/wording once this goes through the CMS.
const FALLBACK: SiteContentSectionContent = {
  nodes: [
    { type: "heading", level: 1, text: "Frequently Asked Questions" },

    { type: "heading", level: 2, text: "For Customers" },
    { type: "heading", level: 3, text: "Can customers chat before ordering?" },
    { type: "paragraph", text: "Yes — you can message a vendor directly to ask questions before you commit to buying anything." },
    { type: "heading", level: 3, text: "Do I need an account to browse?" },
    { type: "paragraph", text: "You can browse vendors and their catalogs without an account. You'll need one to chat, order, or checkout." },
    { type: "heading", level: 3, text: "How do I pay?" },
    { type: "paragraph", text: "the platform supports the payment methods available in your country, selected automatically at checkout." },
    { type: "heading", level: 3, text: "Is my payment information safe?" },
    { type: "paragraph", text: "Payments are processed by our payment providers directly — the platform never stores your card details." },
    { type: "heading", level: 3, text: "Can I track my order?" },
    { type: "paragraph", text: "Yes — every order has a status you can follow from placement through completion, right in the app." },
    { type: "heading", level: 3, text: "What if I have a problem with my order?" },
    { type: "paragraph", text: "You can message the vendor directly, or reach the platform support through the in-app support ticket system." },

    { type: "heading", level: 2, text: "For Vendors" },
    { type: "heading", level: 3, text: "How do I become a vendor?" },
    { type: "paragraph", text: "Download the the platform mobile app and register as a vendor — registration is mobile-only for now." },
    { type: "heading", level: 3, text: "Can vendors sell without verification?" },
    { type: "paragraph", text: "You can set up your storefront right away, but you'll need to complete verification before you appear in customer search and can receive orders." },
    { type: "heading", level: 3, text: "Can I sell in multiple categories?" },
    { type: "paragraph", text: "Your storefront has one primary category, but your catalog can include a range of items within it." },
    { type: "heading", level: 3, text: "How do invoices work?" },
    { type: "paragraph", text: "You can create branded invoices for your customers directly from the app or the Vendor Portal — the number of invoices you can create per month depends on your plan." },
    { type: "heading", level: 3, text: "How do I manage my subscription plan?" },
    { type: "paragraph", text: "From the mobile app or the Vendor Portal — both show the same subscription, so a change in one shows up in the other." },

    { type: "heading", level: 2, text: "Payments & Subscriptions" },
    { type: "heading", level: 3, text: "How do subscriptions work?" },
    { type: "paragraph", text: "Every vendor starts on a free Basic plan. Paid plans (Standard, Pro, Pro+) unlock higher catalog limits, priority placement, and more, billed monthly." },
    { type: "heading", level: 3, text: "Can I cancel anytime?" },
    { type: "paragraph", text: "Yes. Cancelling keeps your current plan active until the end of the billing period you've already paid for — you're never billed again after that unless you resubscribe." },
    { type: "heading", level: 3, text: "What happens if I upgrade or downgrade my plan?" },
    { type: "paragraph", text: "Upgrades take effect immediately after payment. Downgrades take effect at the end of your current billing period, so you keep what you're already paying for until then." },
    { type: "heading", level: 3, text: "What happens if my payment fails?" },
    { type: "paragraph", text: "You'll get a clear \"payment issue\" notice with a grace period to update your payment method before your plan is affected." },
    { type: "heading", level: 3, text: "Does the price ever change?" },
    { type: "paragraph", text: "If a plan's price changes, existing subscribers keep their current price until their next renewal — you're never charged a new price mid-cycle without advance notice." },

    { type: "heading", level: 2, text: "Trust & Safety" },
    { type: "heading", level: 3, text: "How does vendor verification work?" },
    { type: "paragraph", text: "Vendors submit business documents for review. Once approved, their storefront shows a verified badge customers can trust." },
    { type: "heading", level: 3, text: "Can I block a vendor or customer?" },
    { type: "paragraph", text: "Yes — blocking is available from any chat, with a limited exception to keep an already-active order resolvable." },
    { type: "heading", level: 3, text: "How do I contact support?" },
    { type: "paragraph", text: "Use the in-app support ticket system, or the Contact page on this site for general questions." },
  ],
};

export default async function FaqPage() {
  const sections = await getPublishedSiteContent();
  const { content } = sectionOrFallback(sections, "faq", FALLBACK);
  return <MarketingSection content={content} />;
}
