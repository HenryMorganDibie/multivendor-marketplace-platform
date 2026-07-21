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
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-light text-sm font-semibold text-brand">
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
        className={`flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-900 ${
          expanded ? "" : "justify-center"
        }`}
      >
        {avatar}
        {expanded && (
          <>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{businessName}</p>
              {identityLine && <p className="truncate text-xs text-gray-500 dark:text-gray-400">{identityLine}</p>}
            </div>
            <ChevronDown size={16} className={`shrink-0 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} />
          </>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute bottom-full z-20 mb-2 w-56 rounded-xl border border-gray-100 bg-white py-1.5 shadow-soft-md dark:border-gray-800 dark:bg-gray-950 ${
            expanded ? "left-0" : "left-1/2 -translate-x-1/2"
          }`}
        >
          <Link
            href="/account"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-900"
          >
            <User size={16} />
            Your account
          </Link>
          <a
            href="mailto:support@the platform.com"
            role="menuitem"
            className="flex items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-900"
          >
            <HelpCircle size={16} />
            Help and support
          </a>
          <div className="my-1.5 border-t border-gray-100 dark:border-gray-800" />
          <button
            type="button"
            role="menuitem"
            onClick={() => vendorLogout()}
            className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
          >
            <LogOut size={16} />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
