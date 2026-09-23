/**
 * PLATFORM — Subscription Pricing Validator
 * Validates subscription-pricing/pricing.json and
 * subscription-pricing/providerPlanMapping.json against location-data's
 * countries.json. Read-only — never touches Firestore.
 *
 * Run: node validate-pricing.js
 * Exit code 0 = clean, 1 = one or more validation errors found.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PRICING_FILE = path.join(ROOT, "subscription-pricing", "pricing.json");
const MAPPING_FILE = path.join(ROOT, "subscription-pricing", "providerPlanMapping.json");
const PROVIDER_CONFIG_FILE = path.join(ROOT, "subscription-pricing", "providerConfig.json");
const TIER_FILE = path.join(ROOT, "location-data", "countryPricingTier.json");
const COUNTRIES_FILE = path.join(ROOT, "location-data", "countries.json");

const VALID_STATUS = ["active", "inactive", "archived"];
const VALID_TIERS = ["tier_1", "tier_2", "tier_3", "tier_4", "tier_5"];
const PAID_PLAN_IDS = ["standard", "pro", "pro_plus"];
// subscriptionProviderConfig only has the two states — no "archived", unlike
// pricing. Mirrors SubscriptionProviderConfig in functions/src/types4.ts.
const VALID_PROVIDER_CONFIG_STATUS = ["active", "inactive"];
// Must stay in step with VALID_CHECKOUT_PROVIDERS in
// functions/src/subscriptions/countryPricing.ts, which exports
// validateProviderPriority() for exactly these rules. That is TypeScript
// inside functions/, so the checks are mirrored here rather than imported.
const VALID_PROVIDERS = ["paystack", "flutterwave", "stripe"];
// Provider identifier field per provider, used for the cross-file check that
// a configured provider can actually charge a given country+plan.
const PROVIDER_ID_FIELD = {
  paystack: "monthlyPlanCode",
  flutterwave: "monthlyPlanId",
  stripe: "monthlyPriceId",
};

const errors = [];
function fail(id, reason) {
  errors.push(`${id}: ${reason}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

if (!fs.existsSync(COUNTRIES_FILE)) {
  console.error(`location-data/countries.json not found — pricing validation needs it to check countryCode/currencyCode.`);
  process.exit(1);
}
const countries = readJson(COUNTRIES_FILE);
const countryByCode = new Map(countries.map((c) => [c.countryCode, c]));

const pricing = fs.existsSync(PRICING_FILE) ? readJson(PRICING_FILE) : [];
const mapping = fs.existsSync(MAPPING_FILE) ? readJson(MAPPING_FILE) : [];
const providerConfig = fs.existsSync(PROVIDER_CONFIG_FILE) ? readJson(PROVIDER_CONFIG_FILE) : [];
const tiers = fs.existsSync(TIER_FILE) ? readJson(TIER_FILE) : {};

// ── countryPricingTier.json ─────────────────────────────────────────────
//
// Governance only. It records which band a country's price was set from, so a
// future review can ask "what else is tier_3 and are they still consistent?".
//
// Nothing at runtime reads it, and that is the point. pricing.json holds the
// approved local amount and checkout reads that. If a tier could reach checkout
// it could drive a price, and a price would then be derived from a band rather
// than from an amount somebody approved. Two tier_3 countries are expected to
// carry different rounded local prices; the tier does not make them equal.
for (const [code, tier] of Object.entries(tiers)) {
  if (!countryByCode.has(code)) {
    fail(`tier/${code}`, `not a country in location-data/countries.json`);
  }
  if (!VALID_TIERS.includes(tier)) {
    fail(`tier/${code}`, `tier must be one of ${VALID_TIERS.join(", ")}, got "${tier}"`);
  }
}

// A country priced without a recorded tier is not an error — pricing works
// without one — but it is worth surfacing, because it means the next pricing
// review has nothing to group it by.
const untiered = pricing
  .map((r) => r.countryCode)
  .filter((code) => code && !(code in tiers));


// ── pricing.json ────────────────────────────────────────────────────────

const seenPricingCountryCodes = new Set();

for (const record of pricing) {
  const id = record.countryCode || "(no countryCode)";

  if (!record.countryCode) fail(id, "missing countryCode");
  if (!record.currencyCode) fail(id, "missing currencyCode");
  if (!record.plans) fail(id, "missing plans");
  if (!record.status) fail(id, "missing status");

  if (record.countryCode) {
    if (seenPricingCountryCodes.has(record.countryCode)) fail(id, "duplicate countryCode in pricing.json");
    seenPricingCountryCodes.add(record.countryCode);

    const country = countryByCode.get(record.countryCode);
    if (!country) {
      fail(id, `countryCode "${record.countryCode}" has no matching location-data/countries.json record`);
    } else if (record.currencyCode && record.currencyCode !== country.currencyCode) {
      fail(id, `currencyCode "${record.currencyCode}" does not match country's currencyCode "${country.currencyCode}" in countries.json`);
    }
  }

  if (record.status && !VALID_STATUS.includes(record.status)) {
    fail(id, `invalid status "${record.status}"`);
  }

  if (record.plans) {
    for (const planId of PAID_PLAN_IDS) {
      const planEntry = record.plans[planId];
      if (!planEntry) {
        fail(id, `missing plans.${planId}`);
        continue;
      }
      const price = planEntry.monthlyPriceMinorUnits;
      if (typeof price !== "number" || !Number.isInteger(price) || price <= 0) {
        fail(id, `plans.${planId}.monthlyPriceMinorUnits must be a positive integer, got ${JSON.stringify(price)}`);
      }
    }
    // basic is intentionally excluded — flag if present, since it signals a schema misunderstanding.
    if (record.plans.basic !== undefined) {
      fail(id, `plans.basic should not be present — Basic is free in every country and is never stored per-country`);
    }
  }
}

// ── providerPlanMapping.json ────────────────────────────────────────────

const seenMappingIds = new Set();

for (const record of mapping) {
  const id = record.countryCode && record.planId ? `${record.countryCode}-${record.planId}` : "(incomplete record)";

  if (!record.countryCode) fail(id, "missing countryCode");
  if (!record.planId) fail(id, "missing planId");
  if (record.planId && !PAID_PLAN_IDS.includes(record.planId)) {
    fail(id, `invalid planId "${record.planId}" — must be one of: ${PAID_PLAN_IDS.join(", ")}`);
  }
  if (record.countryCode && !countryByCode.has(record.countryCode)) {
    fail(id, `countryCode "${record.countryCode}" has no matching location-data/countries.json record`);
  }
  if (seenMappingIds.has(id)) fail(id, "duplicate countryCode+planId (document ID)");
  seenMappingIds.add(id);

  if (!record.paystack && !record.flutterwave && !record.stripe) {
    fail(id, "at least one of paystack/flutterwave/stripe must be present");
  }
  if (record.paystack && typeof record.paystack.monthlyPlanCode !== "string") fail(id, "paystack.monthlyPlanCode must be a string");
  if (record.flutterwave && typeof record.flutterwave.monthlyPlanId !== "string") fail(id, "flutterwave.monthlyPlanId must be a string");
  if (record.stripe && typeof record.stripe.monthlyPriceId !== "string") fail(id, "stripe.monthlyPriceId must be a string");
}

// ── providerConfig.json ─────────────────────────────────────────────────
//
// The third required piece, and the one nothing used to import. A country can
// have an active price and correct provider plan codes and still be
// unpurchasable without this: buildOfferingsResponse reports
// PAYMENT_PROVIDER_NOT_CONFIGURED unless subscriptionProviderConfig exists,
// is active, and has a non-empty providerPriority.

const seenProviderConfigCodes = new Set();

for (const record of providerConfig) {
  const id = record.countryCode || "(no countryCode)";

  if (!record.countryCode) fail(id, "missing countryCode");
  if (!record.status) fail(id, "missing status");

  if (record.countryCode) {
    if (seenProviderConfigCodes.has(record.countryCode)) fail(id, "duplicate countryCode in providerConfig.json");
    seenProviderConfigCodes.add(record.countryCode);
    if (!countryByCode.has(record.countryCode)) {
      fail(id, `countryCode "${record.countryCode}" has no matching location-data/countries.json record`);
    }
  }

  if (record.status && !VALID_PROVIDER_CONFIG_STATUS.includes(record.status)) {
    fail(id, `invalid status "${record.status}" — must be one of: ${VALID_PROVIDER_CONFIG_STATUS.join(", ")}`);
  }

  // Same three rules as validateProviderPriority() in countryPricing.ts:
  // non-empty, known providers only, no duplicates.
  const priority = record.providerPriority;
  if (!Array.isArray(priority) || priority.length === 0) {
    fail(id, "providerPriority must be a non-empty array");
  } else {
    const seenProviders = new Set();
    for (const p of priority) {
      if (!VALID_PROVIDERS.includes(p)) {
        fail(id, `providerPriority contains an unsupported provider "${p}" — must be one of: ${VALID_PROVIDERS.join(", ")}`);
      }
      if (seenProviders.has(p)) fail(id, `providerPriority contains a duplicate entry "${p}"`);
      seenProviders.add(p);
    }
  }
}

// ── Cross-file coherence ────────────────────────────────────────────────
//
// Warnings, not errors, because loading the three files in stages is a
// legitimate workflow — prices can be agreed before a payment provider is
// even signed up for. But each of these means a vendor in that country will
// not be able to subscribe, so they are reported loudly rather than left to
// be discovered through a failed checkout.

const warnings = [];
const activePricedCountries = pricing.filter((r) => r.status === "active").map((r) => r.countryCode);
const activeProviderConfigByCode = new Map(
  providerConfig.filter((r) => r.status === "active").map((r) => [r.countryCode, r])
);
const mappingById = new Map(
  mapping.map((r) => [`${r.countryCode}-${r.planId}`, r])
);

for (const code of activePricedCountries) {
  const cfg = activeProviderConfigByCode.get(code);
  if (!cfg) {
    warnings.push(`${code}: priced and active, but no active providerConfig — plans will show as unavailable (PAYMENT_PROVIDER_NOT_CONFIGURED)`);
    continue;
  }
  // selectProvider() picks the first provider in the priority list that also
  // has a usable mapping for the requested plan. If no provider in the list
  // can serve a plan, that plan's checkout fails.
  for (const planId of PAID_PLAN_IDS) {
    const entry = mappingById.get(`${code}-${planId}`);
    const usable = (cfg.providerPriority || []).filter((p) => {
      const field = PROVIDER_ID_FIELD[p];
      return entry && entry[p] && typeof entry[p][field] === "string" && entry[p][field].length > 0;
    });
    if (usable.length === 0) {
      const configured = (cfg.providerPriority || []).join(", ") || "(none)";
      warnings.push(`${code}-${planId}: no provider plan mapping for any configured provider (${configured}) — checkout for this plan will fail`);
    }
  }
}

// The reverse direction: configuration that can never be reached.
for (const record of providerConfig) {
  if (record.countryCode && !seenPricingCountryCodes.has(record.countryCode)) {
    warnings.push(`${record.countryCode}: has providerConfig but no pricing record — nothing to sell`);
  }
}
for (const record of mapping) {
  if (record.countryCode && !seenPricingCountryCodes.has(record.countryCode)) {
    warnings.push(`${record.countryCode}-${record.planId}: has a provider plan mapping but no pricing record for that country`);
  }
}

// ── Report ────────────────────────────────────────────────────────────────

console.log(
  `Validating: ${pricing.length} pricing records, ${mapping.length} provider plan mappings, ${providerConfig.length} provider configs\n`
);

function reportWarnings() {
  if (warnings.length === 0) return;
  console.log("");
  console.log(`  ⚠  ${warnings.length} configuration warning(s) — these import fine but block checkout:`);
  for (const w of warnings) console.log(`     - ${w}`);
}

if (errors.length === 0) {
  console.log(`✓ ${pricing.length} pricing records validated`);
  console.log(`✓ ${mapping.length} provider plan mappings validated`);
  console.log(`✓ ${providerConfig.length} provider configs validated`);
  console.log(`✓ ${Object.keys(tiers).length} country tiers validated`);
  if (untiered.length > 0) {
    // A warning, not an error: pricing works without a tier. It only means the
    // next pricing review has nothing to group these by.
    console.log("");
    console.log("  note: priced but no tier recorded — " + untiered.join(", "));
  }
  reportWarnings();
  console.log("");
  console.log("No errors found.");
  process.exit(0);
} else {
  console.log(`✗ ${errors.length} error(s) found:\n`);
  for (const e of errors) console.log(`  ${e}`);
  reportWarnings();
  process.exit(1);
}
