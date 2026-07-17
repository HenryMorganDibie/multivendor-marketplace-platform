import Link from "next/link";

const LEGAL_LINKS = [
  { href: "/privacy-policy", label: "Privacy Policy" },
  { href: "/terms-of-service", label: "Terms of Service" },
  { href: "/vendor-terms", label: "Vendor Terms" },
  { href: "/customer-terms", label: "Customer Terms" },
  { href: "/cookie-policy", label: "Cookie Policy" },
  { href: "/acceptable-use-policy", label: "Acceptable Use Policy" },
];

const COMPANY_LINKS = [
  { href: "/about", label: "About" },
  { href: "/faq", label: "FAQ" },
  { href: "/contact", label: "Contact" },
];

export default function SiteFooter() {
  return (
    <footer className="border-t border-hairline bg-surface-canvas">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
          <div className="col-span-2">
            <p className="text-lg font-extrabold tracking-[-0.02em] text-brand">the platform</p>
            <p className="mt-2 max-w-xs text-sm text-ink-secondary">
              The marketplace connecting vendors and customers directly, built for how people actually buy and sell.
            </p>
          </div>
          <div>
            <p className="text-sm font-semibold text-ink">Company</p>
            <ul className="mt-3 space-y-2">
              {COMPANY_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-sm text-ink-secondary hover:text-brand">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-sm font-semibold text-ink">Legal</p>
            <ul className="mt-3 space-y-2">
              {LEGAL_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-sm text-ink-secondary hover:text-brand">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="mt-10 border-t border-hairline pt-6 text-xs text-ink-tertiary">
          &copy; {new Date().getFullYear()} the platform. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
