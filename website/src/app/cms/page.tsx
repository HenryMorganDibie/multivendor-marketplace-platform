"use client";

import Link from "next/link";
import { SITE_CONTENT_SECTION_IDS } from "@/lib/types";

const SECTION_LABELS: Record<string, string> = {
  home: "Home",
  features: "Features",
  vendors: "Vendors",
  customers: "Customers",
  faq: "FAQ",
  about: "About",
  "privacy-policy": "Privacy Policy",
  "terms-of-service": "Terms of Service",
  "vendor-terms": "Vendor Terms",
  "customer-terms": "Customer Terms",
  "cookie-policy": "Cookie Policy",
  "acceptable-use-policy": "Acceptable Use Policy",
};

export default function CmsIndexPage() {
  return (
    <div>
      <h1 className="text-xl font-semibold">Site Content</h1>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
        Pricing and Contact aren&apos;t edited here — pricing comes from subscription pricing records, and the contact form has no editable copy.
      </p>
      <ul className="mt-6 divide-y divide-gray-100 rounded-2xl border border-gray-100 dark:divide-gray-800 dark:border-gray-800">
        {SITE_CONTENT_SECTION_IDS.map((id) => (
          <li key={id}>
            <Link href={`/cms/${id}`} className="flex items-center justify-between px-4 py-4 hover:bg-gray-50 dark:hover:bg-gray-900">
              <span className="font-medium">{SECTION_LABELS[id] ?? id}</span>
              <span className="text-sm text-gray-400">Edit &rarr;</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
