import Link from "next/link";
import { Instagram } from "lucide-react";

const COMPANY_LINKS = [
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
  { href: "/faq", label: "FAQ" },
];

const CUSTOMER_LINKS = [
  { href: "/customers", label: "Download App" },
  // "Browse Vendors" was removed rather than relabelled: it pointed at the
  // customers marketing page, and there is no public vendor directory to send
  // anyone to. It goes back the moment one exists.
];

const VENDOR_LINKS = [
  { href: "/vendors", label: "Become a Vendor" },
  { href: "https://vendor.example.com", label: "Vendor Login" },
  { href: "/pricing", label: "Pricing" },
];

// Labels match the wording used in the app's registration consent line, so a
// user agrees to "Terms of Use" and then finds a link with that same name here.
// The routes are unchanged; only the display names were inconsistent.
const LEGAL_LINKS = [
  { href: "/privacy-policy", label: "Privacy Policy" },
  { href: "/terms-of-service", label: "Terms of Use" },
  { href: "/vendor-terms", label: "Vendor Agreement" },
  { href: "/customer-terms", label: "Customer Agreement" },
  { href: "/cookie-policy", label: "Cookie Policy" },
  { href: "/acceptable-use-policy", label: "Acceptable Use Policy" },
];

// Only accounts that actually exist are shown. Facebook, LinkedIn, YouTube and
// X were removed rather than left as inert icons: an icon with no destination
// reads as broken, and a footer that advertises five channels Platform is not on
// is worse than one that advertises the one it is. Add each back with its URL
// as the accounts go live.
const SOCIAL_LINKS = [
  { Icon: Instagram, label: "Instagram", href: "https://www.instagram.com/platformhq" },
];

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
            <p className="text-lg font-extrabold tracking-[-0.02em] text-brand">Platform</p>
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
          <p className="text-xs text-ink-tertiary">&copy; {new Date().getFullYear()} Platform. All rights reserved.</p>
          <div className="flex items-center gap-1">
            {SOCIAL_LINKS.map(({ Icon, label, href }) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Platform on ${label}`}
                // 44px target: the bare 16px icons were too small to tap.
                className="inline-flex h-11 w-11 items-center justify-center rounded-button text-ink-tertiary transition hover:bg-surface-muted hover:text-brand"
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
