"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, HelpCircle, LogOut, User } from "lucide-react";
import { vendorLogout } from "@/lib/useVendorAuth";

interface VendorProfileMenuProps {
  businessName: string;
  logoImage: string | null;
  identityLine: string | null; // email or @username, shown under the business name
  expanded: boolean; // true = full sidebar row (avatar + name + chevron), false = avatar-only trigger
}

export function VendorProfileMenu({ businessName, logoImage, identityLine, expanded }: VendorProfileMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const initial = businessName.trim().charAt(0).toUpperCase() || "L";

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const avatar = logoImage ? (
    <img src={logoImage} alt={businessName} className="h-9 w-9 shrink-0 rounded-full object-cover" />
  ) : (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-light text-body-sm font-semibold text-brand">
      {initial}
    </span>
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex min-h-nav-row w-full items-center gap-2.5 rounded-input px-2 text-left transition-colors hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:bg-surface-muted ${
          expanded ? "" : "justify-center"
        }`}
      >
        {avatar}
        {expanded && (
          <>
            <div className="min-w-0 flex-1">
              <p className="truncate text-body-sm font-semibold text-ink">{businessName}</p>
              {identityLine && <p className="truncate text-label-sm text-ink-secondary">{identityLine}</p>}
            </div>
            <ChevronDown size={16} className={`shrink-0 text-ink-tertiary transition-transform ${open ? "rotate-180" : ""}`} />
          </>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute bottom-full z-20 mb-2 w-56 rounded-card border border-hairline bg-white py-1.5 shadow-soft-md ${
            expanded ? "left-0" : "left-1/2 -translate-x-1/2"
          }`}
        >
          <Link
            href="/account"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex min-h-nav-row items-center gap-2.5 px-3.5 text-body-sm font-medium text-ink-secondary transition-colors hover:bg-surface hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:bg-surface-muted"
          >
            <User size={16} />
            Your account
          </Link>
          <a
            href="mailto:support@example.com"
            role="menuitem"
            className="flex min-h-nav-row items-center gap-2.5 px-3.5 text-body-sm font-medium text-ink-secondary transition-colors hover:bg-surface hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:bg-surface-muted"
          >
            <HelpCircle size={16} />
            Help and support
          </a>
          <div className="my-1.5 border-t border-hairline" />
          <button
            type="button"
            role="menuitem"
            onClick={() => vendorLogout()}
            className="flex min-h-nav-row w-full items-center gap-2.5 px-3.5 text-left text-body-sm font-medium text-red-600 transition-colors hover:bg-red-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500 active:bg-red-100"
          >
            <LogOut size={16} />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
