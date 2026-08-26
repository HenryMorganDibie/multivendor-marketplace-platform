import type { Metadata } from "next";
import PortalChrome from "./PortalChrome";
import "./globals.css";

// This app was extracted from platform-backend/web's /portal route group
// into its own repo (platform-vendor-portal) — routes that used to be
// /portal/subscription etc. are now just /subscription at the root of
// this app's own domain (vendor.theplatform.com). The public invoice
// share-link view (/invoice/[shareToken]) came along too since it shares
// the same invoice types/components and is functionally part of the
// portal's invoice feature, not the marketing site's.
export const metadata: Metadata = {
  title: {
    default: "Vendor Portal | the platform",
    template: "%s | the platform Vendor Portal",
  },
  description: "Manage your the platform vendor subscription, billing, and invoices.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col bg-white text-ink antialiased">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-brand focus:px-4 focus:py-2 focus:text-white"
        >
          Skip to main content
        </a>
        <PortalChrome>{children}</PortalChrome>
      </body>
    </html>
  );
}
