import type { Metadata } from "next";
import "./globals.css";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.the platform.com";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "the platform — The Marketplace Built for Direct Trade",
    template: "%s | the platform",
  },
  description:
    "the platform connects vendors and customers directly — browse, chat, order, and pay, all in one marketplace.",
  openGraph: {
    type: "website",
    siteName: "the platform",
    images: ["/og-image.png"],
  },
  icons: {
    icon: "/favicon.ico",
  },
};

// Deliberately no SiteHeader/SiteFooter here — those are marketing-site
// chrome and belong only to the (marketing) route group. /portal and /cms
// are separate authenticated app surfaces with their own nav (see their
// own layout.tsx); showing the public "Become a Vendor" marketing nav on
// top of a logged-in vendor's dashboard was a real bug, caught by actually
// logging into the portal and looking at the screenshot.
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
        {children}
      </body>
    </html>
  );
}
