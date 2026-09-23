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
      {/**
        * 80vw capped at 328px, rather than a flat w-72 with an 85vw ceiling.
        * On a narrow phone the old rule gave the drawer up to 85% of the
        * screen, so the page behind it all but disappeared; the cap keeps it
        * to a panel on large phones instead of scaling with them.
        */}
      <div className="absolute inset-y-0 left-0 flex w-[80vw] max-w-drawer flex-col bg-white pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 shadow-soft-md">
        <div className="flex h-topbar items-center justify-between px-4">
          <div>
            <p className="text-card-title text-ink">Platform</p>
            <p className="text-label-sm text-ink-tertiary">Vendor Portal</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="-mr-1.5 rounded-full p-2 text-ink-tertiary transition-colors hover:bg-surface hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:bg-surface-muted"
          >
            <X size={20} />
          </button>
        </div>

        {/* mt-8 (32px) below the drawer header was more separation than a list
            of three items needed. */}
        <nav aria-label="Vendor Portal" className="mt-3 flex-1 overflow-y-auto px-3">
          {sections.map((section) => (
            <div key={section.id} className="mb-3">
              <p className="px-3 pb-1 text-label-sm font-semibold uppercase tracking-wide text-ink-tertiary">{section.label}</p>
              <div className="flex flex-col gap-0.5">
                {section.items.map((item) => {
                  const active = pathname?.startsWith(item.route);
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.id}
                      href={item.route}
                      onClick={onClose}
                      aria-current={active ? "page" : undefined}
                      /* min-h-nav-row is 50px. The active row in particular
                         read as oversized before, being tall enough that the
                         highlight dominated the panel. */
                      className={`flex min-h-nav-row items-center gap-3 rounded-input px-3 text-body-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
                        active
                          ? "bg-brand-light text-brand"
                          : "text-ink-secondary hover:bg-surface hover:text-ink active:bg-surface-muted"
                      }`}
                    >
                      <Icon size={18} className="shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-hairline px-3 pt-3">
          <VendorProfileMenu businessName={businessName} logoImage={logoImage} identityLine={identityLine} expanded />
        </div>
      </div>
    </div>
  );
}
