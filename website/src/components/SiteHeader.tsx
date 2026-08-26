"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_LINKS = [
  { href: "/features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/vendors", label: "Vendors" },
  { href: "/customers", label: "Customers" },
  { href: "/faq", label: "FAQ" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
];

export default function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <Link href="/" className="text-xl font-extrabold tracking-[-0.02em] text-brand">
          the platform
        </Link>
        <nav aria-label="Primary" className="hidden gap-6 md:flex">
          {NAV_LINKS.map((link) => {
            const isActive = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={isActive ? "page" : undefined}
                className={`border-b-2 pb-1 text-sm font-medium transition ${
                  isActive ? "border-brand font-semibold text-brand" : "border-transparent text-ink-secondary hover:text-brand"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-3">
          <a href="https://vendor.theplatform.com" className="hidden text-sm font-medium text-ink-secondary hover:text-brand sm:inline">
            Vendor Login
          </a>
          <Link
            href="/vendors"
            className="rounded-button bg-brand px-4 py-2 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-dark"
          >
            Become a Vendor
          </Link>
        </div>
      </div>
    </header>
  );
}
