"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import { enabledNavSections } from "@/lib/navConfig";
import { VendorProfileMenu } from "./VendorProfileMenu";

interface MobileNavigationDrawerProps {
  open: boolean;
  onClose: () => void;
  businessName: string;
  logoImage: string | null;
  identityLine: string | null;
}

export function MobileNavigationDrawer({ open, onClose, businessName, logoImage, identityLine }: MobileNavigationDrawerProps) {
  const pathname = usePathname();
  const sections = enabledNavSections();

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-30 md:hidden">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-white py-6 shadow-soft-md dark:bg-gray-950">
        <div className="flex items-center justify-between px-4">
          <div>
            <p className="text-lg font-bold">the platform</p>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Vendor Portal</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close menu" className="rounded-full p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900">
            <X size={20} />
          </button>
        </div>

        <nav aria-label="Vendor Portal" className="mt-8 flex-1 overflow-y-auto px-3">
          {sections.map((section) => (
            <div key={section.id} className="mb-4">
              <p className="px-3 pb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">{section.label}</p>
              <div className="flex flex-col gap-1">
                {section.items.map((item) => {
                  const active = pathname?.startsWith(item.route);
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.id}
                      href={item.route}
                      onClick={onClose}
                      className={`flex min-h-[44px] items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium ${
                        active ? "bg-brand-light text-brand" : "text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-900"
                      }`}
                    >
                      <Icon size={18} />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-gray-100 px-3 pt-3 dark:border-gray-800">
          <VendorProfileMenu businessName={businessName} logoImage={logoImage} identityLine={identityLine} expanded />
        </div>
      </div>
    </div>
  );
}
