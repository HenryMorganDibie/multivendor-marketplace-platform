"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useVendorAuth, vendorLogout } from "@/lib/useVendorAuth";

// Auth-gated, never public/indexed (robots.ts disallows /portal) — no
// benefit to static generation, and prerendering would evaluate the
// Firebase client SDK at build time with no real runtime env config
// available yet.
export const dynamic = "force-dynamic";

const PORTAL_NAV = [
  { href: "/portal/subscription", label: "Subscription" },
  { href: "/portal/billing", label: "Billing History" },
  { href: "/portal/invoices", label: "Invoices" },
];

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const { loading, user, access, error } = useVendorAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user && pathname !== "/portal/login") {
      router.replace("/portal/login");
    }
  }, [loading, user, pathname, router]);

  if (pathname === "/portal/login") {
    return <div className="mx-auto max-w-md px-4 py-16 sm:px-6">{children}</div>;
  }

  if (loading) {
    return <div className="mx-auto max-w-5xl px-4 py-16 text-sm text-gray-500 sm:px-6">Loading…</div>;
  }

  if (!user) {
    return null; // redirecting to /portal/login
  }

  if (error) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      </div>
    );
  }

  if (access?.accessState === "denied") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center sm:px-6">
        <h1 className="text-2xl font-bold">Portal access unavailable</h1>
        <p className="mt-3 text-gray-600 dark:text-gray-400">
          This account doesn&apos;t currently have access to the Vendor Portal. If you believe this is a mistake, contact support.
        </p>
        <button
          type="button"
          onClick={() => vendorLogout()}
          className="mt-8 rounded-full border border-gray-300 px-6 py-2 text-sm font-semibold hover:border-brand hover:text-brand"
        >
          Sign out
        </button>
      </div>
    );
  }

  if (access?.accessState === "incomplete_registration") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center sm:px-6">
        <h1 className="text-2xl font-bold">Finish setting up your vendor account</h1>
        <p className="mt-3 text-gray-600 dark:text-gray-400">
          Vendor registration is completed in the the platform mobile app. Download the app to finish setting up your account, then come back here to log in.
        </p>
        <div className="mt-8 flex justify-center gap-4">
          <a href="https://apps.apple.com/" className="rounded-full bg-black px-6 py-3 text-sm font-semibold text-white hover:bg-gray-800">
            App Store
          </a>
          <a href="https://play.google.com/store" className="rounded-full bg-black px-6 py-3 text-sm font-semibold text-white hover:bg-gray-800">
            Google Play
          </a>
        </div>
      </div>
    );
  }

  const readOnly = access?.accessState === "read_only";

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <div className="flex items-center justify-between border-b border-gray-100 pb-6 dark:border-gray-800">
        <div>
          <p className="text-xl font-bold text-brand">{access?.businessName ?? "Vendor Portal"}</p>
          {readOnly && (
            <p className="mt-1 text-xs font-medium text-amber-600 dark:text-amber-400">
              Your account is suspended — billing actions are restricted.
            </p>
          )}
        </div>
        <button type="button" onClick={() => vendorLogout()} className="text-sm font-medium text-gray-600 hover:text-brand dark:text-gray-400">
          Sign out
        </button>
      </div>

      <nav aria-label="Vendor Portal" className="mt-6 flex gap-6 border-b border-gray-100 pb-3 dark:border-gray-800">
        {PORTAL_NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`text-sm font-medium ${pathname?.startsWith(item.href) ? "text-brand" : "text-gray-600 hover:text-brand dark:text-gray-400"}`}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="mt-8" data-portal-readonly={readOnly ? "true" : "false"}>
        {children}
      </div>
    </div>
  );
}
