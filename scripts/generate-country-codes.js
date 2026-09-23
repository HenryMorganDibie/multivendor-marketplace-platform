/**
 * Regenerates functions/src/utils/countryCode.ts from the location catalogue.
 *
 * Run after changing location-data/countries.json:
 *   node scripts/generate-country-codes.js
 *
 * The map is generated rather than hand-maintained because it was hand-
 * maintained: it held two countries while the pricing page offered six, and the
 * four missing ones resolved to things like "UNITED KINGDOM", which matched no
 * pricing record. Generating it means launching a new country needs no code
 * change.
 */
const fs = require("fs");
const path = require("path");

const CATALOGUE = path.join(__dirname, "..", "location-data", "countries.json");
const TARGET = path.join(__dirname, "..", "functions", "src", "utils", "countryCode.ts");

const countries = JSON.parse(fs.readFileSync(CATALOGUE, "utf8"));

const entries = [];
for (const c of [...countries].sort((a, b) => a.countryCode.localeCompare(b.countryCode))) {
  const { name, countryCode, normalizedName } = c;
  // Accept the display name, the normalised name and the code itself, so both
  // "Côte d'Ivoire" and "cote d ivoire" resolve if the catalogue lists both.
  const keys = new Set([name.toLowerCase(), (normalizedName || name).toLowerCase(), countryCode.toLowerCase()]);
  for (const k of [...keys].sort()) {
    entries.push(`  ${JSON.stringify(k)}: "${countryCode}",`);
  }
}

const header = `/**
 * Country name or ISO code to ISO 3166-1 alpha-2, for all ${countries.length} countries in the
 * location catalogue.
 *
 * Generated from location-data/countries.json, which is the approved source of
 * truth for country data. Regenerate with scripts/generate-country-codes.js if
 * that file changes.
 *
 * This map used to hold two entries, Nigeria and the United States. Anything
 * else fell through to .toUpperCase(), so "United Kingdom" resolved to
 * "UNITED KINGDOM" rather than "GB". Nothing errored: the value was simply a
 * code that could never match a subscriptionPricing/{countryCode} record or a
 * countryAvailability entry, so per-country pricing silently failed for every
 * country except the two listed. The pricing page offers six.
 *
 * Building it from the catalogue rather than adding four more entries by hand
 * means the next country to launch needs no code change at all.
 */
const COUNTRY_NAME_TO_CODE: Record<string, string> = {
`;

const footer = `};

/**
 * Accepts a country name or an ISO code and always returns an ISO code.
 *
 * Falls back to upper-casing the input when nothing matches, which preserves
 * the previous behaviour for anything genuinely unrecognised rather than
 * returning an empty string and losing the value entirely.
 */
export function resolveCountryCode(rawCountry: string | undefined | null): string {
  if (!rawCountry) return "";
  const key = rawCountry.trim().toLowerCase();
  return COUNTRY_NAME_TO_CODE[key] ?? rawCountry.trim().toUpperCase();
}
`;

fs.writeFileSync(TARGET, header + entries.join("\n") + "\n" + footer, "utf8");
console.log(`Wrote ${entries.length} lookup keys for ${countries.length} countries to`);
console.log(`  ${path.relative(process.cwd(), TARGET)}`);
