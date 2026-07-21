// Country selector for unauthenticated visitors (Section 1.1) — shows only
// countries the platform knows about, not all ~200 in the world, per the client's
// direction. This exact list is provisional ("we will add the list of all
// supported countries for mvp") — update it in place once that's final.
//
// Sends the same countryCode the backend's resolveCountryCode() would
// produce for a registering user, so a visitor selecting "Nigeria" here and
// a vendor who later registers with "Nigeria" resolve to the identical
// subscriptionPricing document key. Nigeria and the United States are the
// only countries with seeded pricing right now (functions/src/utils/
// countryCode.ts) — every other entry, and NG/US too until pricing is
// actually seeded, correctly shows the "not available yet" + waitlist
// state. That's expected, not a bug — it's the honest current state.
export const PRICING_COUNTRIES: { label: string; countryCode: string }[] = [
  { label: "Nigeria", countryCode: "NG" },
  { label: "South Africa", countryCode: "SOUTH AFRICA" },
  { label: "Canada", countryCode: "CANADA" },
  { label: "United States", countryCode: "US" },
  { label: "Australia", countryCode: "AUSTRALIA" },
  { label: "United Kingdom", countryCode: "UNITED KINGDOM" },
];

const LOCALE_HINT_TO_COUNTRY: Record<string, string> = {
  "en-ng": "NG",
  "en-us": "US",
  "en-gb": "UNITED KINGDOM",
  "en-ca": "CANADA",
  "en-au": "AUSTRALIA",
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
