import type { Config } from "tailwindcss";

// darkMode: 'class' (not the default 'media') means dark: utilities only
// activate when a "dark" class is explicitly present on <html> — nothing
// in this app adds one, so the portal stays white regardless of the
// visitor's OS theme. The mobile app (rork-the platform) has no dark theme
// either — constants/theme.ts's backgroundMain is '#FFFFFF' unconditionally.
//
// This file is intentionally identical to the platform-website's copy — shared
// design tokens across the two separate repos, per the client's direction
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
        // Ported directly from rork-the platform/expo/constants/theme.ts
        // (the platformColors) so the web app's palette matches the mobile
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
