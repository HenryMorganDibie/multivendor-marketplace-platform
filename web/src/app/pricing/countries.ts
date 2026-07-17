// Country selector for unauthenticated visitors (Section 1.1). Sends the
// same countryCode the backend's resolveCountryCode() would produce for a
// registering user, so a visitor selecting "Nigeria" here and a vendor who
// later registers with "Nigeria" resolve to the identical subscriptionPricing
// document key. Nigeria and the United States are the only seeded MVP
// markets (functions/src/utils/countryCode.ts) — other entries will
// correctly show the "not available yet" state until an admin seeds
// pricing for them, which is expected behavior, not a bug.
export const PRICING_COUNTRIES: { label: string; countryCode: string }[] = [
  { label: "Nigeria", countryCode: "NG" },
  { label: "United States", countryCode: "US" },
  { label: "Ghana", countryCode: "GHANA" },
  { label: "Kenya", countryCode: "KENYA" },
  { label: "South Africa", countryCode: "SOUTH AFRICA" },
  { label: "United Kingdom", countryCode: "UNITED KINGDOM" },
  { label: "Canada", countryCode: "CANADA" },
];

const LOCALE_HINT_TO_COUNTRY: Record<string, string> = {
  "en-ng": "NG",
  "en-us": "US",
  "en-gb": "UNITED KINGDOM",
  "en-ca": "CANADA",
  "en-gh": "GHANA",
  "en-ke": "KENYA",
  "en-za": "SOUTH AFRICA",
};

/**
 * Suggests an initial country from the browser locale — never authoritative
 * (Section 1.1). Returns null (not a default) when there's no usable
 * signal, so the page shows the neutral "select a country" prompt instead
 * of silently defaulting to Nigeria/NGN.
 */
export function suggestCountryFromLocale(): string | null {
  if (typeof navigator === "undefined") return null;
  const locale = navigator.language?.toLowerCase();
  if (!locale) return null;
  return LOCALE_HINT_TO_COUNTRY[locale] ?? null;
}
