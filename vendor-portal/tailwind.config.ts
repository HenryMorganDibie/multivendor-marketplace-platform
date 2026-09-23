import type { Config } from "tailwindcss";

// darkMode: 'class' (not the default 'media') means dark: utilities only
// activate when a "dark" class is explicitly present on <html> — nothing
// in this app adds one, so the portal stays white regardless of the
// visitor's OS theme. The mobile app (rork-platform) has no dark theme
// either — constants/theme.ts's backgroundMain is '#FFFFFF' unconditionally.
//
// This file is intentionally identical to this repo (website/)'s copy — shared
// design tokens across the two separate repos, per the Founder's direction
// (branding/UI/design tokens are shared, code is not).
const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#FF7A28",
          dark: "#E0631A",
          darker: "#C9520F",
          light: "#FFF4EC",
        },
        // Ported directly from rork-platform/expo/constants/theme.ts
        // (PlatformColors) so the web app's palette matches the mobile
        // app's exactly, not just approximates it.
        ink: {
          DEFAULT: "#0B0C0F", // textPrimary
          secondary: "#4F5663", // textSecondary
          tertiary: "#7A8290", // textTertiary
          disabled: "#A8AFBA", // textDisabled
        },
        surface: {
          canvas: "#F8F9FB", // backgroundCanvas
          DEFAULT: "#F4F5F8", // surface
          elevated: "#FAFBFC", // surfaceElevated
          muted: "#EFF1F5", // surfaceMuted
          tinted: "#FBF7F3", // surfaceTinted
        },
        hairline: {
          DEFAULT: "#EEF0F4", // border
          soft: "#F2F4F7", // borderSoft
          strong: "#D9DDE3", // borderStrong
        },
      },
      fontFamily: {
        // The mobile app loads no custom font (no expo-font asset, no
        // useFonts call) — it runs entirely on the OS system font,
        // i.e. San Francisco/SF Pro on iOS, Roboto on Android. This is
        // the standard web equivalent of "the OS system font", and not
        // coincidentally is also what apple.com itself uses.
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          '"SF Pro Text"',
          '"SF Pro Display"',
          '"Segoe UI"',
          "Roboto",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
      },
      borderRadius: {
        // Radii from theme.ts
        input: "14px",
        button: "16px",
        card: "18px",
        "card-lg": "22px",
      },
      /**
       * A named type scale, so sizes stop being chosen per page.
       *
       * Every screen previously picked its own heading and body sizes, which
       * is why secondary text ended up reading almost as prominently as the
       * content it described. These are the only sizes any portal screen
       * should use; line heights and weights are baked in so a heading can't
       * be half-applied.
       */
      fontSize: {
        "page-title": ["1.75rem", { lineHeight: "2.125rem", fontWeight: "700" }],
        "section-title": ["1.3125rem", { lineHeight: "1.625rem", fontWeight: "600" }],
        "card-title": ["1.0625rem", { lineHeight: "1.375rem", fontWeight: "600" }],
        "body-base": ["1rem", { lineHeight: "1.5rem" }],
        "body-sm": ["0.9375rem", { lineHeight: "1.375rem" }],
        "label-sm": ["0.8125rem", { lineHeight: "1.125rem" }],
        /** Buttons are their own step at 16px/600, not body-sm. */
        button: ["1rem", { lineHeight: "1.25rem", fontWeight: "600" }],
        "metric-lg": ["1.625rem", { lineHeight: "1.875rem", fontWeight: "700" }],
      },
      spacing: {
        /**
         * The density fix, as tokens rather than per-file guesses.
         *
         * Horizontal page padding was ~36px on mobile, card padding and
         * section gaps 35-50px, so four short usage values filled an entire
         * phone screen. These are the four measurements every page uses now.
         */
        "page-x": "1.25rem", // 20px page gutter on mobile
        "card-p": "1.25rem", // 20px inside a card
        "section-y": "1.75rem", // 28px between sections
        "card-gap": "0.875rem", // 14px between sibling cards
        /** Mobile header height, excluding the safe-area inset above it. */
        topbar: "4rem", // 64px
      },
      maxWidth: {
        /** Drawer cap, so it stops covering ~80% of a large phone. */
        drawer: "20.5rem", // 328px
      },
      minHeight: {
        /** Menu/nav row height - was far taller than it needed to be. */
        "nav-row": "3.125rem", // 50px
      },
      boxShadow: {
        // Shadows.sm / Shadows.md from theme.ts — soft, diffuse, low
        // opacity, never harsh (explicitly "mimics Apple HIG depth cues").
        soft: "0 2px 8px rgba(11,12,15,0.05)",
        "soft-md": "0 6px 16px rgba(11,12,15,0.07)",
      },
    },
  },
  plugins: [],
};

export default config;
