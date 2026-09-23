"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { enabledNavSections } from "@/lib/navConfig";
import { VendorProfileMenu } from "./VendorProfileMenu";

interface VendorSidebarProps {
  businessName: string;
  logoImage: string | null;
  identityLine: string | null;
}

export function VendorSidebar({ businessName, logoImage, identityLine }: VendorSidebarProps) {
  const pathname = usePathname();
  const sections = enabledNavSections();

  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-gray-100 py-6 md:flex dark:border-gray-800">
      <div className="px-4">
        <p className="text-lg font-bold">Platform</p>
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Vendor Portal</p>
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
                    aria-current={active ? "page" : undefined}
                    /* Same row height, focus ring and pressed state as the
                       mobile drawer, so the two navigations don't drift. */
                    className={`flex min-h-nav-row items-center gap-3 rounded-input px-3 text-body-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
                      active
                        ? "bg-brand-light text-brand"
                        : "text-ink-secondary hover:bg-surface hover:text-ink active:bg-surface-muted"
                    }`}
                  >
                    <Icon size={18} className="shrink-0" />
                    <span className="truncate">{item.label}</span>
                    {item.badge ? (
                      <span className="ml-auto rounded-full bg-brand px-1.5 py-0.5 text-[10px] font-semibold text-white">{item.badge}</span>
                    ) : null}
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
    </aside>
  );
}
