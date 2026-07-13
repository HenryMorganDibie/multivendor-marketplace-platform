/**
 * THE PLATFORM — Location Data Validator
 * Enforces every rule in THE PLATFORM LOCATION SPEC v1.5, Section 4, against
 * location-data/countries.json, location-data/states/*.json, and
 * location-data/locations/*.json. Read-only — never touches Firestore.
 *
 * Run: node validate-locations.js
 * Exit code 0 = clean, 1 = one or more validation errors found.
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "location-data");
const VALID_STATUS = ["active", "inactive", "archived"];
const VALID_STATE_TYPES = ["state", "province", "region", "territory"];
const VALID_LOCATION_TYPES = ["city", "area", "district", "town"];
// Intl.supportedValuesOf('timeZone') is unreliable for this: depending on the
// ICU data bundled with Node, it can return old-style alias names (e.g.
// 'Asia/Calcutta' instead of 'Asia/Kolkata') and omit valid Links entirely
// (e.g. 'America/Yellowknife'). Constructing a DateTimeFormat resolves
// aliases correctly and is the actual authority on "is this a real zone".
function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const errors = [];
function fail(id, reason) {
  errors.push(`${id}: ${reason}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function requireFields(record, id, fields) {
  for (const f of fields) {
    if (record[f] === undefined || record[f] === null || record[f] === "") {
      fail(id, `missing required field '${f}'`);
    }
  }
}

function slugify(name) {
  return name
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── Load ──────────────────────────────────────────────────────────────────

if (!fs.existsSync(path.join(DATA_DIR, "countries.json"))) {
  console.error(`countries.json not found at ${DATA_DIR}`);
  process.exit(1);
}

const countries = readJson(path.join(DATA_DIR, "countries.json"));
const statesDir = path.join(DATA_DIR, "states");
const locationsDir = path.join(DATA_DIR, "locations");

const stateFiles = fs.existsSync(statesDir)
  ? fs.readdirSync(statesDir).filter((f) => f.endsWith(".json"))
  : [];
const locationFiles = fs.existsSync(locationsDir)
  ? fs.readdirSync(locationsDir).filter((f) => f.endsWith(".json"))
  : [];

let allStates = []; // flattened, with source file attached
let allLocations = [];

for (const file of stateFiles) {
  const fileCode = file.replace(".json", "");
  const records = readJson(path.join(statesDir, file));
  for (const s of records) allStates.push({ ...s, __file: file, __fileCode: fileCode });
}
for (const file of locationFiles) {
  const fileStateId = file.replace(".json", "");
  const records = readJson(path.join(locationsDir, file));
  for (const l of records) allLocations.push({ ...l, __file: file, __fileStateId: fileStateId });
}

// ── Rule 1 + 5 + 7: Countries ────────────────────────────────────────────

const countryRequired = [
  "countryCode", "name", "normalizedName", "dialCode", "currencyCode",
  "currencySymbol", "flagEmoji", "defaultLocale", "status", "sortOrder",
];
const seenCountryIds = new Set();
const seenCountryNormNames = new Set();
const countryCodeSet = new Set();

for (const c of countries) {
  const id = c.countryCode || "(no code)";
  requireFields(c, id, countryRequired);

  if (c.countryCode) {
    if (!/^[A-Z]{2}$/.test(c.countryCode)) fail(id, `countryCode must be exactly 2 uppercase letters, got '${c.countryCode}'`);
    if (seenCountryIds.has(c.countryCode)) fail(id, "duplicate countryCode (document ID)");
    seenCountryIds.add(c.countryCode);
    countryCodeSet.add(c.countryCode);
  }
  if (c.normalizedName) {
    if (seenCountryNormNames.has(c.normalizedName)) fail(id, `duplicate normalizedName '${c.normalizedName}' among countries`);
    seenCountryNormNames.add(c.normalizedName);
  }
  if (c.dialCode && !/^\+[0-9]+$/.test(c.dialCode)) fail(id, `dialCode must start with '+' followed by digits, got '${c.dialCode}'`);
  if (c.currencyCode && !/^[A-Z]{3}$/.test(c.currencyCode)) fail(id, `currencyCode must be exactly 3 uppercase letters, got '${c.currencyCode}'`);
  if (c.status && !VALID_STATUS.includes(c.status)) fail(id, `invalid status '${c.status}'`);
}

// ── Rule 1 + 3 + 4 + 5 + 7: States ───────────────────────────────────────

const stateRequired = [
  "stateId", "countryCode", "stateCode", "name", "normalizedName", "type", "status", "sortOrder",
];
const seenStateIds = new Set();
const stateIdSet = new Set();
const normNamesByCountry = new Map(); // countryCode -> Set(normalizedName)

for (const s of allStates) {
  const id = s.stateId || `(${s.__file}, no stateId)`;
  requireFields(s, id, stateRequired);

  if (s.countryCode && s.countryCode !== s.__fileCode) {
    fail(id, `countryCode '${s.countryCode}' does not match filename states/${s.__file}`);
  }
  if (s.countryCode && !countryCodeSet.has(s.countryCode)) {
    fail(id, `countryCode '${s.countryCode}' has no matching countries.json record`);
  }
  if (s.stateCode && !/^[A-Z0-9]+$/.test(s.stateCode)) {
    fail(id, `stateCode must be uppercase alphanumeric, got '${s.stateCode}'`);
  }
  if (s.stateId && s.countryCode && s.stateCode && s.stateId !== `${s.countryCode}-${s.stateCode}`) {
    fail(id, `stateId must equal '{countryCode}-{stateCode}' (expected '${s.countryCode}-${s.stateCode}')`);
  }
  if (s.type && !VALID_STATE_TYPES.includes(s.type)) fail(id, `invalid type '${s.type}'`);
  if (s.status && !VALID_STATUS.includes(s.status)) fail(id, `invalid status '${s.status}'`);

  if (s.stateId) {
    if (seenStateIds.has(s.stateId)) fail(id, "duplicate stateId (document ID)");
    seenStateIds.add(s.stateId);
    stateIdSet.add(s.stateId);
  }
  if (s.normalizedName && s.countryCode) {
    if (!normNamesByCountry.has(s.countryCode)) normNamesByCountry.set(s.countryCode, new Set());
    const set = normNamesByCountry.get(s.countryCode);
    if (set.has(s.normalizedName)) fail(id, `duplicate normalizedName '${s.normalizedName}' within country ${s.countryCode}`);
    set.add(s.normalizedName);
  }
}

// ── Rule 1 + 3 + 4 + 5 + 6 + 7: Locations ────────────────────────────────

const locationRequired = [
  "locationId", "countryCode", "stateId", "stateCode", "name", "normalizedName",
  "slug", "locationType", "timeZone", "status", "sortOrder",
];
const seenLocationIds = new Set();
const normNamesByState = new Map(); // stateId -> Set(normalizedName)
const stateById = new Map(allStates.map((s) => [s.stateId, s]));

for (const l of allLocations) {
  const id = l.locationId || `(${l.__file}, no locationId)`;
  requireFields(l, id, locationRequired);

  if (l.stateId && l.stateId !== l.__fileStateId) {
    fail(id, `stateId '${l.stateId}' does not match filename locations/${l.__file}`);
  }
  const parentState = l.stateId ? stateById.get(l.stateId) : undefined;
  if (l.stateId && !parentState) {
    fail(id, `stateId '${l.stateId}' has no matching state record`);
  } else if (parentState && l.countryCode !== parentState.countryCode) {
    fail(id, `countryCode '${l.countryCode}' does not match parent state's countryCode '${parentState.countryCode}'`);
  }
  if (l.stateCode && parentState && l.stateCode !== parentState.stateCode) {
    fail(id, `stateCode '${l.stateCode}' does not match parent state's stateCode '${parentState.stateCode}'`);
  }

  if (l.slug && !/^[A-Z0-9-]+$/.test(l.slug)) fail(id, `slug must be uppercase alphanumeric+hyphen only, got '${l.slug}'`);
  if (l.slug && l.name && l.slug !== slugify(l.name)) {
    fail(id, `slug '${l.slug}' does not match hyphenated form of name '${l.name}' (expected '${slugify(l.name)}')`);
  }
  if (l.locationId && l.countryCode && l.stateCode && l.slug) {
    const expected = `${l.countryCode}-${l.stateCode}-${l.slug}`;
    if (l.locationId !== expected) fail(id, `locationId must equal '{countryCode}-{stateCode}-{slug}' (expected '${expected}')`);
  }
  if (l.locationType && !VALID_LOCATION_TYPES.includes(l.locationType)) fail(id, `invalid locationType '${l.locationType}'`);
  if (l.status && !VALID_STATUS.includes(l.status)) fail(id, `invalid status '${l.status}'`);
  if (l.timeZone && !isValidTimeZone(l.timeZone)) {
    fail(id, `timeZone '${l.timeZone}' is not a recognized IANA timezone identifier`);
  }

  if (l.locationId) {
    if (seenLocationIds.has(l.locationId)) fail(id, "duplicate locationId (document ID)");
    seenLocationIds.add(l.locationId);
  }
  if (l.normalizedName && l.stateId) {
    if (!normNamesByState.has(l.stateId)) normNamesByState.set(l.stateId, new Set());
    const set = normNamesByState.get(l.stateId);
    if (set.has(l.normalizedName)) fail(id, `duplicate normalizedName '${l.normalizedName}' within state ${l.stateId}`);
    set.add(l.normalizedName);
  }
}

// ── Report ────────────────────────────────────────────────────────────────

console.log(`Validating: ${countries.length} countries, ${allStates.length} states, ${allLocations.length} locations\n`);

if (errors.length === 0) {
  console.log(`✓ ${countries.length} countries validated`);
  console.log(`✓ ${allStates.length} states validated`);
  console.log(`✓ ${allLocations.length} locations validated`);
  console.log("No errors found.");
  process.exit(0);
} else {
  console.log(`✗ ${errors.length} error(s) found:\n`);
  for (const e of errors) console.log(`  ${e}`);
  process.exit(1);
}
