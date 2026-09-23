"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

// The "Features" item opens a dropdown of real page sections (see
// app/(marketing)/page.tsx's section ids -- the redesign is the homepage
// itself now, not a separate /features subpage) rather than a plain link --
// same click-to-open pattern as whatsapp.com/messaging's own Features nav
// item, but pointed at Platform's actual feature areas, not WhatsApp's
// (Calling/Groups/Channels don't exist here).
const FEATURES_DROPDOWN = [
  { href: "/", label: "All Features" },
  { href: "/#for-customers", label: "Discover & Search" },
  { href: "/#chat", label: "Direct Chat" },
  { href: "/#for-vendors", label: "Orders & Invoicing" },
  { href: "/#more-features", label: "Trust & Verification" },
];

const NAV_LINKS = [
  { href: "/pricing", label: "Pricing" },
  { href: "/vendors", label: "Vendors" },
  { href: "/customers", label: "Customers" },
  { href: "/faq", label: "FAQ" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
];

const VENDOR_LOGIN_URL = "https://vendor.example.com";

export default function SiteHeader() {
  const pathname = usePathname();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isFeaturesOpen, setIsFeaturesOpen] = useState(false);
  const [isMobileFeaturesOpen, setIsMobileFeaturesOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const featuresRef = useRef<HTMLDivElement>(null);
  const featuresToggleRef = useRef<HTMLButtonElement>(null);

  const closeMenu = useCallback(() => setIsMenuOpen(false), []);
  const closeFeatures = useCallback(() => setIsFeaturesOpen(false), []);

  // Navigating away must close the drawer. Without this the panel stays over
  // the new page, because Next keeps the layout mounted across route changes.
  useEffect(() => {
    setIsMenuOpen(false);
    setIsFeaturesOpen(false);
    setIsMobileFeaturesOpen(false);
  }, [pathname]);

  // Click-to-open, not hover-only (a Features mega-menu that only opens on
  // hover is unusable on touch devices with no hover state at all) --
  // closes on an outside click or Escape, matching the mobile drawer's own
  // dismissal pattern below.
  useEffect(() => {
    if (!isFeaturesOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!featuresRef.current?.contains(event.target as Node)) {
        setIsFeaturesOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsFeaturesOpen(false);
        featuresToggleRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isFeaturesOpen]);

  useEffect(() => {
    if (!isMenuOpen) return;

    // Escape closes, and focus returns to the button that opened it rather
    // than being dumped at the top of the document.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsMenuOpen(false);
        toggleRef.current?.focus();
      }
    };

    // The page behind a full-height drawer should not scroll under it.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);

    // Move focus into the panel so keyboard and screen-reader users land on
    // the navigation they just opened.
    panelRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isMenuOpen]);

  return (
    <>
      {/* The dimming overlay is a sibling of the header, not a child of it.
          backdrop-blur makes the header a containing block for position: fixed
          descendants, so an overlay inside it resolved inset-0 against the
          header's own box and dimmed only the bar itself, leaving the page
          behind the drawer undimmed. Out here, inset-0 means the viewport. */}
      {isMenuOpen ? (
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          onClick={closeMenu}
          className="fixed inset-0 z-30 cursor-default bg-ink/25 md:hidden"
        />
      ) : null}

      <header className="sticky top-0 z-40 border-b border-hairline bg-white/90 backdrop-blur md:relative">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <Link href="/" className="text-xl font-extrabold tracking-[-0.02em] text-brand">
          Platform
        </Link>

        <nav aria-label="Primary" className="hidden gap-6 md:flex">
          <div ref={featuresRef} className="relative">
            <button
              ref={featuresToggleRef}
              type="button"
              onClick={() => setIsFeaturesOpen((open) => !open)}
              aria-expanded={isFeaturesOpen}
              aria-haspopup="menu"
              aria-controls="features-menu"
              className={`flex items-center gap-1 border-b-2 pb-1 text-sm font-medium transition ${
                pathname === "/"
                  ? "border-brand font-semibold text-brand"
                  : "border-transparent text-ink-secondary hover:text-brand"
              }`}
            >
              Features
              <ChevronDown size={14} className={`transition-transform ${isFeaturesOpen ? "rotate-180" : ""}`} />
            </button>
            {isFeaturesOpen ? (
              <div
                id="features-menu"
                role="menu"
                aria-label="Features"
                className="absolute left-0 top-full z-40 mt-3 w-56 rounded-card border border-hairline bg-white p-2 shadow-soft-md"
              >
                {FEATURES_DROPDOWN.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    role="menuitem"
                    onClick={closeFeatures}
                    className="block rounded-button px-3 py-2.5 text-sm font-medium text-ink-secondary transition hover:bg-surface-canvas hover:text-brand"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>
          {NAV_LINKS.map((link) => {
            const isActive = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={isActive ? "page" : undefined}
                className={`border-b-2 pb-1 text-sm font-medium transition ${
                  isActive ? "border-brand font-semibold text-brand" : "border-transparent text-ink-secondary hover:text-brand"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2 sm:gap-3">
          <a href={VENDOR_LOGIN_URL} className="hidden text-sm font-medium text-ink-secondary hover:text-brand sm:inline">
            Vendor Login
          </a>
          <Link
            href="/vendors"
            className="rounded-button bg-brand px-3 py-2 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-dark sm:px-4"
          >
            Become a Vendor
          </Link>

          {/* Below md the primary nav is hidden, so without this control the
              only things reachable on a phone were the logo and this CTA. */}
          <button
            ref={toggleRef}
            type="button"
            onClick={() => setIsMenuOpen((open) => !open)}
            aria-expanded={isMenuOpen}
            aria-controls="mobile-nav"
            aria-label={isMenuOpen ? "Close menu" : "Open menu"}
            className="-mr-1 inline-flex h-11 w-11 items-center justify-center rounded-button text-ink-secondary transition hover:bg-surface-muted hover:text-brand md:hidden"
          >
            {isMenuOpen ? <CloseIcon /> : <MenuIcon />}
          </button>
        </div>
      </div>

      {isMenuOpen ? (
        <div className="md:hidden">
          {/* Anchored to the header with top-full rather than a hardcoded
              offset, so it stays put if the header's height ever changes. */}
          <div
            id="mobile-nav"
            ref={panelRef}
            tabIndex={-1}
            className="absolute inset-x-0 top-full z-40 max-h-[80vh] overflow-y-auto border-t border-hairline bg-white px-4 pb-6 pt-2 shadow-soft outline-none"
          >
            <nav aria-label="Primary mobile">
              <ul className="flex flex-col">
                <li className="border-b border-hairline">
                  <button
                    type="button"
                    onClick={() => setIsMobileFeaturesOpen((open) => !open)}
                    aria-expanded={isMobileFeaturesOpen}
                    aria-controls="mobile-features-submenu"
                    className={`flex min-h-[48px] w-full items-center justify-between text-base transition ${
                      pathname === "/features" ? "font-semibold text-brand" : "text-ink-secondary hover:text-brand"
                    }`}
                  >
                    Features
                    <ChevronDown size={18} className={`transition-transform ${isMobileFeaturesOpen ? "rotate-180" : ""}`} />
                  </button>
                  {isMobileFeaturesOpen ? (
                    <ul id="mobile-features-submenu" className="pb-2">
                      {FEATURES_DROPDOWN.map((item) => (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            // Explicit close, not just the pathname-change effect --
                            // a hash link to a section on the page already open
                            // (e.g. tapping this while already on /features) never
                            // changes pathname, so that effect alone would leave
                            // the drawer covering the page it just scrolled to.
                            onClick={closeMenu}
                            className="flex min-h-[44px] items-center pl-4 text-sm text-ink-secondary transition hover:text-brand"
                          >
                            {item.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
                {NAV_LINKS.map((link) => {
                  const isActive = pathname === link.href;
                  return (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        aria-current={isActive ? "page" : undefined}
                        // min-height 48px: a comfortable tap target, which the
                        // 14px desktop links were not on a phone.
                        className={`flex min-h-[48px] items-center border-b border-hairline text-base transition ${
                          isActive ? "font-semibold text-brand" : "text-ink-secondary hover:text-brand"
                        }`}
                      >
                        {link.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>

            <a
              href={VENDOR_LOGIN_URL}
              className="mt-4 flex min-h-[48px] items-center justify-center rounded-button border border-hairline text-base font-medium text-ink-secondary transition hover:border-brand hover:text-brand"
            >
              Vendor Login
            </a>
          </div>
        </div>
      ) : null}
      </header>
    </>
  );
}

function MenuIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M3 6h18M3 12h18M3 18h18" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
