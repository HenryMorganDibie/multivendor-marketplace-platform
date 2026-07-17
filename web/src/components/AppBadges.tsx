// Recreations of the standard "Download on the App Store" / "Get it on
// Google Play" badges — the format both Apple and Google publish design
// guidelines for specifically so app listings can use them. Matches the
// reference (uber.com's footer): black fill, white outline/text, icon +
// two-line label, not a plain solid rectangle.

export function AppStoreBadge({ href }: { href: string }) {
  return (
    <a
      href={href}
      className="flex items-center gap-2 rounded-lg border border-white/25 bg-black px-3.5 py-2 transition hover:bg-gray-900"
    >
      <svg viewBox="0 0 24 24" className="h-6 w-6 shrink-0 fill-white" aria-hidden="true">
        <path d="M16.365 1.43c0 1.14-.415 2.185-1.243 3.045-.828.86-1.966 1.51-3.06 1.42-.14-1.1.42-2.24 1.24-3.09.84-.87 2.28-1.5 3.06-1.375zM20.5 17.05c-.55 1.27-.82 1.84-1.53 2.96-.99 1.55-2.39 3.48-4.12 3.5-1.53.02-1.92-.99-4-.98-2.08.01-2.51 1-4.04.98-1.73-.02-3.06-1.76-4.05-3.31C.4 17.6-.34 13.8 1.09 11.3c.99-1.75 2.76-2.86 4.68-2.88 1.63-.02 3.17 1.1 4.16 1.1.99 0 2.86-1.36 4.82-1.16.82.03 3.13.33 4.61 2.49-.12.07-2.75 1.61-2.72 4.79.03 3.8 3.34 5.07 3.36 5.08z" />
      </svg>
      <span className="leading-tight text-white">
        <span className="block text-[10px]">Download on the</span>
        <span className="block text-base font-semibold -mt-0.5">App Store</span>
      </span>
    </a>
  );
}

export function GooglePlayBadge({ href }: { href: string }) {
  return (
    <a
      href={href}
      className="flex items-center gap-2 rounded-lg border border-white/25 bg-black px-3.5 py-2 transition hover:bg-gray-900"
    >
      <svg viewBox="0 0 24 24" className="h-6 w-6 shrink-0" aria-hidden="true">
        <polygon points="5,3 5,21 14,12" fill="#00D4FF" />
        <polygon points="5,3 14,12 17.5,8.5" fill="#00E884" />
        <polygon points="5,21 14,12 17.5,15.5" fill="#FF3A44" />
        <polygon points="17.5,8.5 21,10.5 21,13.5 17.5,15.5 14,12" fill="#FFD400" />
      </svg>
      <span className="leading-tight text-white">
        <span className="block text-[10px]">GET IT ON</span>
        <span className="block text-base font-semibold -mt-0.5">Google Play</span>
      </span>
    </a>
  );
}
