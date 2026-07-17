"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAdminAuth, adminLogout } from "@/lib/useAdminAuth";

// Auth-gated, never public/indexed (robots.ts disallows /cms) — no benefit
// to static generation, and prerendering would evaluate the Firebase
// client SDK at build time with no real runtime env config available yet.
export const dynamic = "force-dynamic";

export default function CmsLayout({ children }: { children: React.ReactNode }) {
  const { loading, user, isSuperAdmin } = useAdminAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user && pathname !== "/cms/login") {
      router.replace("/cms/login");
    }
  }, [loading, user, pathname, router]);

  if (pathname === "/cms/login") {
    return <div id="main-content" className="mx-auto max-w-md px-4 py-16 sm:px-6">{children}</div>;
  }

  if (loading) {
    return <div id="main-content" className="mx-auto max-w-5xl px-4 py-16 text-sm text-gray-500 sm:px-6">Loading…</div>;
  }

  if (!user) return null;

  if (!isSuperAdmin) {
    return (
      <div id="main-content" className="mx-auto max-w-2xl px-4 py-16 text-center sm:px-6">
        <h1 className="text-2xl font-bold">Super-Admin access required</h1>
        <p className="mt-3 text-gray-600 dark:text-gray-400">This account doesn&apos;t have CMS editing access.</p>
        <button
          type="button"
          onClick={() => adminLogout()}
          className="mt-8 rounded-full border border-gray-300 px-6 py-2 text-sm font-semibold hover:border-brand hover:text-brand"
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div id="main-content" className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <div className="flex items-center justify-between border-b border-gray-100 pb-6 dark:border-gray-800">
        <Link href="/cms" className="text-xl font-bold text-brand">
          the platform CMS
        </Link>
        <button type="button" onClick={() => adminLogout()} className="text-sm font-medium text-gray-600 hover:text-brand dark:text-gray-400">
          Sign out
        </button>
      </div>
      <div className="mt-8">{children}</div>
    </div>
  );
}
