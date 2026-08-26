import Link from "next/link";
import { Instagram, Facebook, Linkedin, Youtube } from "lucide-react";

const COMPANY_LINKS = [
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
  { href: "/faq", label: "FAQ" },
];

const CUSTOMER_LINKS = [
  { href: "/customers", label: "Download App" },
  { href: "/customers", label: "Browse Vendors" },
];

const VENDOR_LINKS = [
  { href: "/vendors", label: "Become a Vendor" },
  { href: "https://vendor.theplatform.com", label: "Vendor Login" },
  { href: "/pricing", label: "Pricing" },
];

const LEGAL_LINKS = [
  { href: "/privacy-policy", label: "Privacy Policy" },
  { href: "/terms-of-service", label: "Terms of Service" },
  { href: "/vendor-terms", label: "Vendor Terms" },
  { href: "/customer-terms", label: "Customer Terms" },
  { href: "/cookie-policy", label: "Cookie Policy" },
  { href: "/acceptable-use-policy", label: "Acceptable Use Policy" },
];

// No real social handles exist yet — rendered as inert icons (not links to
// nowhere) rather than fabricating URLs. Swap for real <a href> once
// the platform's accounts exist.
const SOCIAL_ICONS = [
  { Icon: Instagram, label: "Instagram" },
  { Icon: Facebook, label: "Facebook" },
  { Icon: Linkedin, label: "LinkedIn" },
  { Icon: Youtube, label: "YouTube" },
];

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
      <path d="M18.9 2H22l-7.6 8.7L23 22h-6.9l-5.4-6.9L4.4 22H1.3l8.1-9.3L1 2h7l4.9 6.3L18.9 2Zm-1.2 18h1.9L7.4 4H5.4l12.3 16Z" />
    </svg>
  );
}

function FooterColumn({ title, links }: { title: string; links: { href: string; label: string }[] }) {
  return (
    <div>
      <p className="text-sm font-semibold text-ink">{title}</p>
      <ul className="mt-2.5 space-y-1.5">
        {links.map((link) => (
          <li key={link.label}>
            <Link href={link.href} className="text-sm text-ink-secondary hover:text-brand">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function SiteFooter() {
  return (
    <footer className="border-t border-hairline bg-surface-canvas">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 md:grid-cols-6">
          <div className="col-span-2 md:col-span-2">
            <p className="text-lg font-extrabold tracking-[-0.02em] text-brand">the platform</p>
            <p className="mt-2 max-w-xs text-sm text-ink-secondary">
              The marketplace connecting vendors and customers directly, built for how people actually buy and sell.
            </p>
          </div>
          <FooterColumn title="Company" links={COMPANY_LINKS} />
          <FooterColumn title="Customers" links={CUSTOMER_LINKS} />
          <FooterColumn title="Vendors" links={VENDOR_LINKS} />
          <FooterColumn title="Legal" links={LEGAL_LINKS} />
        </div>
        <div className="mt-8 flex flex-col items-start justify-between gap-4 border-t border-hairline pt-5 sm:flex-row sm:items-center">
          <p className="text-xs text-ink-tertiary">&copy; {new Date().getFullYear()} the platform. All rights reserved.</p>
          <div className="flex items-center gap-3 text-ink-tertiary" aria-label="Social links coming soon">
            {SOCIAL_ICONS.map(({ Icon, label }) => (
              <Icon key={label} className="h-4 w-4" aria-label={label} />
            ))}
            <XIcon />
          </div>
        </div>
      </div>
    </footer>
  );
}
