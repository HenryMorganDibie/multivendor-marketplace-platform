"use client";

import { HelpCircle, Menu } from "lucide-react";

interface VendorTopbarProps {
  onOpenMenu: () => void;
}

/**
 * The mobile chrome bar.
 *
 * Two changes from the original. It was ~56px of padding-driven height with
 * no fixed measurement, which read as a lot of empty space above and below a
 * single line of text; it is now a defined 64px row (`h-topbar`), excluding
 * the safe-area inset the layout adds above it.
 *
 * More importantly it showed the *current page* name here ("Subscription",
 * "Invoices", "Vendor Portal" depending on route), so the one persistent
 * piece of chrome changed identity on every navigation and the product name
 * disappeared entirely on most screens. The bar now always says Platform
 * Vendor Portal and the page announces itself through its own <h1> below,
 * which also means there is exactly one h1 per page rather than a heading
 * competing with a chrome label.
 */
export function VendorTopbar({ onOpenMenu }: VendorTopbarProps) {
  return (
    <div className="flex h-topbar items-center justify-between border-b border-hairline px-page-x sm:px-6">
      <div className="flex min-w-0 items-center gap-2.5">
        <button
          type="button"
          onClick={onOpenMenu}
          aria-label="Open menu"
          className="-ml-1.5 rounded-full p-2 text-ink-secondary transition-colors hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:bg-surface-muted md:hidden"
        >
          <Menu size={20} />
        </button>
        <p className="truncate text-label-sm font-semibold uppercase tracking-wide text-ink-tertiary md:hidden">
          Platform Vendor Portal
        </p>
      </div>
      <a
        href="mailto:support@example.com"
        aria-label="Help and support"
        className="-mr-1.5 rounded-full p-2 text-ink-tertiary transition-colors hover:bg-surface hover:text-ink-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:bg-surface-muted"
      >
        <HelpCircle size={18} />
      </a>
    </div>
  );
}
