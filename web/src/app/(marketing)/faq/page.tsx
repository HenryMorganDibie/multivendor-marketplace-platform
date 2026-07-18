import type { Metadata } from "next";
import FaqAccordion from "./FaqAccordion";
import { getPublishedSiteContent, sectionOrFallback } from "@/lib/siteContent";
import { SiteContentSectionContent } from "@/lib/types";

export const metadata: Metadata = {
  title: "FAQ",
  description: "Common questions about buying and selling on the platform.",
  alternates: { canonical: "/faq" },
};

// Answers describe actual built behavior (backend-verified this session),
// not aspirational copy — safe to publish as-is, though the client may still
// want to adjust tone/wording once this goes through the CMS. Structure:
// heading level 2 = category, heading level 3 = question, the paragraph
// right after it = answer — see FaqAccordion.tsx for how this is parsed
// into an expandable list.
const FALLBACK: SiteContentSectionContent = {
  nodes: [
    { type: "heading", level: 2, text: "General" },
    { type: "heading", level: 3, text: "What is the platform?" },
    { type: "paragraph", text: "A marketplace that connects customers and vendors directly — browse, chat, order, and pay, all in one platform." },
    { type: "heading", level: 3, text: "Where is the platform available?" },
    { type: "paragraph", text: "the platform is expanding country by country. Check the Pricing page's country selector to see what's live where you are, or join the waitlist for your country." },

    { type: "heading", level: 2, text: "Customers" },
    { type: "heading", level: 3, text: "How do I order?" },
    { type: "paragraph", text: "Browse a vendor's catalog, add what you want, and check out with the payment method available in your country." },
    { type: "heading", level: 3, text: "How do I pay?" },
    { type: "paragraph", text: "the platform supports the payment methods available in your country, selected automatically at checkout." },
    { type: "heading", level: 3, text: "Can I contact vendors?" },
    { type: "paragraph", text: "Yes — you can message a vendor directly to ask questions before you commit to buying anything." },
    { type: "heading", level: 3, text: "Can I cancel?" },
    { type: "paragraph", text: "Order cancellation depends on where it is in the vendor's fulfillment process — message the vendor directly to ask." },
    { type: "heading", level: 3, text: "Can I track my order?" },
    { type: "paragraph", text: "Yes — every order has a status you can follow from placement through completion, right in the app." },
    { type: "heading", level: 3, text: "Do I need an account to browse?" },
    { type: "paragraph", text: "You can browse vendors and their catalogs without an account. You'll need one to chat, order, or checkout." },

    { type: "heading", level: 2, text: "Vendors" },
    { type: "heading", level: 3, text: "How do I register?" },
    { type: "paragraph", text: "Download the the platform mobile app and register as a vendor — registration is mobile-only for now." },
    { type: "heading", level: 3, text: "Why verification?" },
    { type: "paragraph", text: "It's what earns your storefront the verified badge customers look for, and it's required before you appear in customer search and can receive orders." },
    { type: "heading", level: 3, text: "How do subscriptions work?" },
    { type: "paragraph", text: "Every vendor starts on a free Basic plan. Paid plans (Standard, Pro, Pro+) unlock higher catalog limits, priority placement, and more, billed monthly." },
    { type: "heading", level: 3, text: "How do invoices work?" },
    { type: "paragraph", text: "Create branded invoices for your customers from the app or the Vendor Portal — how many you can create per month depends on your plan." },
    { type: "heading", level: 3, text: "What are external orders?" },
    { type: "paragraph", text: "Orders you record from outside the marketplace (phone, in-person) so they're tracked alongside everything else. Available on Standard plan and above." },
    { type: "heading", level: 3, text: "What is the Vendor Portal?" },
    { type: "paragraph", text: "A web dashboard for managing your subscription, billing history, and invoices from a browser — the mobile app and portal always show the same data." },

    { type: "heading", level: 2, text: "Billing" },
    { type: "heading", level: 3, text: "What payment providers do you support?" },
    { type: "paragraph", text: "the platform routes payments through regional providers automatically based on your country — you never see or choose between them, you just pay." },
    { type: "heading", level: 3, text: "Can I cancel anytime?" },
    { type: "paragraph", text: "Yes. Cancelling keeps your current plan active until the end of the billing period you've already paid for — you're never billed again after that unless you resubscribe." },
    { type: "heading", level: 3, text: "What happens if I upgrade or downgrade my plan?" },
    { type: "paragraph", text: "Upgrades take effect immediately after payment. Downgrades take effect at the end of your current billing period, so you keep what you're already paying for until then." },
    { type: "heading", level: 3, text: "Does the price ever change?" },
    { type: "paragraph", text: "If a plan's price changes, existing subscribers keep their current price until their next renewal — you're never charged a new price mid-cycle without advance notice." },
    { type: "heading", level: 3, text: "What's the refund policy?" },
    { type: "paragraph", text: "Subscription payments are non-refundable once processed — cancelling stops future billing but doesn't refund the current period. See the Terms of Service for the full policy." },

    { type: "heading", level: 2, text: "Security" },
    { type: "heading", level: 3, text: "How is my data protected?" },
    { type: "paragraph", text: "Authentication runs through Firebase Auth, not a custom credential store. Payments are processed by our payment providers directly — the platform never stores your card details. See the Privacy Policy for the full detail." },
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
  return (
    <section className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-extrabold tracking-[-0.02em] text-ink sm:text-4xl">Frequently Asked Questions</h1>
      <div className="mt-8">
        <FaqAccordion content={content} />
      </div>
    </section>
  );
}
