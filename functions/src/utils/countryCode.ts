/**
 * Minimal country name → ISO 3166-1 alpha-2 code mapping.
 *
 * Phase 1's completeRegistration originally stored the raw client-supplied
 * country string (e.g. "Nigeria") directly as countryCode, which broke
 * Phase 3's countryAvailability gating (that collection is keyed by ISO
 * code, e.g. "NG"). This map is the fix — accepts either a full country
 * name or an already-valid 2-letter code and always returns a code.
 *
 * MVP scope: Nigeria is the only launch market, so this map is
 * intentionally small. Extend as new countries launch.
 */
const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  nigeria: "NG",
  ng: "NG",
  // Added for per-country subscription pricing (checkout now looks up
  // subscriptionPricing/{countryCode} by real ISO code) — without this,
  // "United States" fell through to .toUpperCase() and produced
  // "UNITED STATES", which would never match a seeded "US" pricing record.
  "united states": "US",
  us: "US",
};

export function resolveCountryCode(rawCountry: string | undefined | null): string {
  if (!rawCountry) return "";
  const key = rawCountry.trim().toLowerCase();
  return COUNTRY_NAME_TO_CODE[key] ?? rawCountry.trim().toUpperCase();
}
