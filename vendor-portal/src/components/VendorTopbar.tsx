"use client";

import { usePathname } from "next/navigation";
import { HelpCircle, Menu } from "lucide-react";
import { findNavItemForPath } from "@/lib/navConfig";

interface VendorTopbarProps {
  onOpenMenu: () => void;
}

export function VendorTopbar({ onOpenMenu }: VendorTopbarProps) {
  const pathname = usePathname();
  const currentItem = findNavItemForPath(pathname);

  return (
    <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3.5 sm:px-6 dark:border-gray-800">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onOpenMenu}
          aria-label="Open menu"
          className="rounded-full p-1.5 text-gray-600 hover:bg-gray-100 md:hidden dark:text-gray-400 dark:hover:bg-gray-900"
        >
          <Menu size={20} />
        </button>
        <p className="text-sm font-semibold text-gray-500 dark:text-gray-400 md:hidden">{currentItem?.label ?? "Vendor Portal"}</p>
      </div>
      <a
        href="mailto:support@theplatform.com"
        aria-label="Help and support"
        className="rounded-full p-1.5 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-900"
      >
        <HelpCircle size={18} />
      </a>
    </div>
  );
}
