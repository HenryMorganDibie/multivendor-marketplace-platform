"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useVendorAuth, vendorLogout } from "@/lib/useVendorAuth";
import { VendorSidebar } from "@/components/VendorSidebar";
import { VendorTopbar } from "@/components/VendorTopbar";
import { MobileNavigationDrawer } from "@/components/MobileNavigationDrawer";

export default function PortalChrome({ children }: { children: React.ReactNode }) {
  const { loading, user, access, error } = useVendorAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user && pathname !== "/login" && !pathname?.startsWith("/invoice/")) {
      router.replace("/login");
    }
  }, [loading, user, pathname, router]);

  // Public invoice share links need no auth at all.
  if (pathname?.startsWith("/invoice/")) {
    return <>{children}</>;
  }

  if (pathname === "/login") {
    return <div id="main-content" className="mx-auto max-w-md px-4 py-16 sm:px-6">{children}</div>;
  }

  if (loading) {
    return <div id="main-content" className="mx-auto max-w-5xl px-4 py-16 text-sm text-gray-500 sm:px-6">Loading…</div>;
  }

  if (!user) {
    return null; // redirecting to /login
  }

  if (error) {
    return (
      <div id="main-content" className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      </div>
    );
  }

  if (access?.accessState === "denied") {
    return (
      <div id="main-content" className="mx-auto max-w-2xl px-4 py-16 text-center sm:px-6">
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
      <div id="main-content" className="mx-auto max-w-2xl px-4 py-16 text-center sm:px-6">
        <h1 className="text-2xl font-bold">Finish setting up your vendor account</h1>
        <p className="mt-3 text-gray-600 dark:text-gray-400">
          Vendor registration is completed in the Platform mobile app. Download the app to finish setting up your account, then come back here to log in.
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
  /**
   * Falls back to the vendor's @username, not the literal string "Vendor
   * Portal". A vendor who hasn't set a business name yet had the product's own
   * name presented as their business, which just looked like the profile row
   * was showing an email and nothing else.
   */
  const businessName = access?.businessName?.trim() || (access?.username ? `@${access.username}` : "Your account");
  const identityLine = access?.email ?? (access?.username ? `@${access.username}` : null);
  const logoImage = access?.logoImage ?? null;

  return (
    <div className="flex min-h-screen">
      <VendorSidebar businessName={businessName} logoImage={logoImage} identityLine={identityLine} />
      <MobileNavigationDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        businessName={businessName}
        logoImage={logoImage}
        identityLine={identityLine}
      />

      <div className="min-w-0 flex-1">
        <VendorTopbar onOpenMenu={() => setDrawerOpen(true)} />

        {/**
          * px-page-x (20px) rather than the previous effective ~36px gutter,
          * and py-6 rather than py-8: on a 375px phone the old padding cost
          * roughly a fifth of the usable width. pb accounts for
          * safe-area-inset-bottom instead of padding the bottom generously to
          * compensate for Safari's overlaid controls.
          */}
        <div
          id="main-content"
          className="mx-auto w-full max-w-[1320px] px-page-x py-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:px-6 lg:px-8"
          data-portal-readonly={readOnly ? "true" : "false"}
        >
          {readOnly && (
            <p className="mb-5 rounded-card bg-amber-50 px-4 py-3 text-body-sm font-medium text-amber-800">
              Your account is suspended, so billing actions are restricted.
            </p>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
