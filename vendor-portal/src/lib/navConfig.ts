import { CreditCard, History, LucideIcon, Receipt } from "lucide-react";

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  route: string;
  enabled: boolean;
  badge?: number;
}

export interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

// Only MVP sections are enabled today (Billing: Subscription, Billing
// History, Invoices). Add future sections/items here — Dashboard, Account,
// Business details, Usage, Payment methods, Team access, Integrations,
// Security, Help — without touching VendorSidebar/MobileNavigationDrawer,
// which just render whatever's enabled.
export const PORTAL_NAV_SECTIONS: NavSection[] = [
  {
    id: "billing",
    label: "Billing",
    items: [
      { id: "subscription", label: "Subscription", icon: CreditCard, route: "/subscription", enabled: true },
      { id: "billing-history", label: "Billing History", icon: History, route: "/billing", enabled: true },
      { id: "invoices", label: "Invoices", icon: Receipt, route: "/invoices", enabled: true },
    ],
  },
];

export function enabledNavSections(): NavSection[] {
  return PORTAL_NAV_SECTIONS.map((section) => ({ ...section, items: section.items.filter((item) => item.enabled) })).filter(
    (section) => section.items.length > 0
  );
}

export function findNavItemForPath(pathname: string | null): NavItem | undefined {
  if (!pathname) return undefined;
  for (const section of PORTAL_NAV_SECTIONS) {
    const match = section.items.find((item) => pathname.startsWith(item.route));
    if (match) return match;
  }
  return undefined;
}
