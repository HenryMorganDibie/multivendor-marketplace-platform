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
    <footer className="border-t border-gray-100 bg-gray-50 dark:border-gray-800 dark:bg-gray-900">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
          <div className="col-span-2">
            <p className="text-lg font-bold text-brand">the platform</p>
            <p className="mt-2 max-w-xs text-sm text-gray-600 dark:text-gray-400">
              The marketplace connecting vendors and customers directly, built for how people actually buy and sell.
            </p>
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Company</p>
            <ul className="mt-3 space-y-2">
              {COMPANY_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-sm text-gray-600 hover:text-brand dark:text-gray-400">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Legal</p>
            <ul className="mt-3 space-y-2">
              {LEGAL_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-sm text-gray-600 hover:text-brand dark:text-gray-400">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="mt-10 border-t border-gray-200 pt-6 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-500">
          &copy; {new Date().getFullYear()} the platform. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
