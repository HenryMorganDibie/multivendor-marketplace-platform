/**
 * THE PLATFORM — Subscription Pricing Validator
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
const COUNTRIES_FILE = path.join(ROOT, "location-data", "countries.json");

const VALID_STATUS = ["active", "inactive", "archived"];
const PAID_PLAN_IDS = ["standard", "pro", "pro_plus"];

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

// ── Report ────────────────────────────────────────────────────────────────

console.log(`Validating: ${pricing.length} pricing records, ${mapping.length} provider plan mappings\n`);

if (errors.length === 0) {
  console.log(`✓ ${pricing.length} pricing records validated`);
  console.log(`✓ ${mapping.length} provider plan mappings validated`);
  console.log("No errors found.");
  process.exit(0);
} else {
  console.log(`✗ ${errors.length} error(s) found:\n`);
  for (const e of errors) console.log(`  ${e}`);
  process.exit(1);
}
