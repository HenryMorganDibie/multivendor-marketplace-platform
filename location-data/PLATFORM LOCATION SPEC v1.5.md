# the platform Canonical Location Specification (v1.5)

Version: 1.5
Owner: the platform
Status: Approved
Last Updated:
Next Review:

**Status:** Canonical — this is the single source of truth for Country, State/Province, and Area/City data across the platform backend and frontend. All future countries must be added following this specification.

**v1.4 update (corrections from the client's second review):**
1. Removed the pricing/scope conclusion from the Section 8 closing note — the spec now stays purely technical and doesn't determine chargeability.
2. Added Section 8.5, server-side enforcement: order creation must independently re-evaluate Store Status against trusted server time and reject if closed, never trusting a client-supplied or cached `isOpenNow` value.
3. Schedule boundaries are now explicitly defined as start-inclusive, end-exclusive (Section 8.3).
4. Late-night hours: `"24:00"` is now permitted as an `end` value only, letting vendors represent e.g. `22:00`–`24:00` plus `00:00`–`02:00` the following day. True overnight periods within a single entry remain unsupported for MVP (Section 8.6).
5. `weeklyHours` is now a fixed `Weekday` union type with all seven days required, replacing the open-ended `[weekday: string]` index type (Section 8.1).
6. Added `updatedAt`, `manualStatusChangedAt`, and `timeZoneConfirmedAt` to the Store Status model (Section 8.1).
7. Revised the closing ownership note to acknowledge the platform's use of standard ISO 3166, BCP 47, and IANA identifiers while confirming the platform owns and maintains its own runtime catalogue, with no third-party runtime dependency (see closing note at the end of this document).

**Data ownership:** All location data is authored and owned by the platform. No third-party API or dataset is used at runtime or as a data source. This document defines the schema, conventions, and process so that the client (or any future contributor) can add new countries independently, without depending on Henry or any external service.


---

## 1. JSON Schema

### 1.1 Country

```typescript
interface CountryDocument {
  countryCode: string;        // required — ISO 3166-1 alpha-2, uppercase, e.g. "NG". This is the document ID.
  name: string;                // required — official common name, e.g. "Nigeria"
  normalizedName: string;      // required — lowercase, trimmed, no diacritics, e.g. "nigeria"
  dialCode: string;            // required — international calling code with leading "+", e.g. "+234"
  currencyCode: string;        // required — ISO 4217, e.g. "NGN"
  currencySymbol: string;      // required — e.g. "₦"
  flagEmoji: string;           // required — Unicode flag emoji, e.g. "🇳🇬"
  defaultLocale: string;       // required — BCP 47 tag, e.g. "en-NG"
  status: "active" | "inactive" | "archived";  // required
  sortOrder: number;           // required — integer, controls display order in dropdowns
  createdAt: Timestamp;        // required — server timestamp, set once, never overwritten
  updatedAt: Timestamp;        // required — server timestamp, updated on any field change
}
```

### 1.2 State / Province

```typescript
interface StateDocument {
  stateId: string;             // required — "{countryCode}-{stateCode}", e.g. "NG-LA". This is the document ID.
  countryCode: string;         // required — must reference an existing countries/{countryCode} document
  stateCode: string;           // required — short code unique within the country, e.g. "LA"
  name: string;                // required — e.g. "Lagos"
  normalizedName: string;      // required — lowercase, trimmed, e.g. "lagos"
  type: "state" | "province" | "region" | "territory";  // required — matches the local administrative term
  status: "active" | "inactive" | "archived";  // required
  sortOrder: number;           // required
  createdAt: Timestamp;        // required
  updatedAt: Timestamp;        // required
}
```

**Correction (v1.2):** timezone does not live on Country or State. Country and state cannot be relied upon universally for timezone, since many jurisdictions span multiple time zones (the US, Canada, Australia, Russia, and others each contain several). Timezone is required on the **Area/City (Location)** level only — see Section 1.3 below.

### 1.3 Area / City

```typescript
interface LocationDocument {
  locationId: string;          // required — "{countryCode}-{stateCode}-{SLUG}", e.g. "NG-LA-LEKKI". This is the document ID.
  countryCode: string;         // required — denormalized from parent state, for query convenience
  stateId: string;             // required — must reference an existing states/{stateId} document
  stateCode: string;           // required — denormalized from parent state, for query convenience
  name: string;                // required — e.g. "Lekki"
  normalizedName: string;      // required — lowercase, trimmed, e.g. "lekki"
  slug: string;                // required — URL/ID-safe form, e.g. "lekki"
  locationType: "city" | "area" | "district" | "town";  // required
  timeZone: string;            // required — IANA timezone identifier, e.g. "Africa/Lagos", "America/Toronto".
                                // This is the authoritative timezone source for this location. Used to populate
                                // businessLocation.timeZone / businessTimeZone on the vendor document when this
                                // location is selected during onboarding.
  status: "active" | "inactive" | "archived";  // required
  sortOrder: number;           // required
  createdAt: Timestamp;        // required
  updatedAt: Timestamp;        // required
}
```

---

## 2. Document ID Convention

| Level | Format | Example |
|---|---|---|
| Country | `{COUNTRYCODE}` | `NG` |
| State/Province | `{COUNTRYCODE}-{STATECODE}` | `NG-LA` |
| Area/City | `{COUNTRYCODE}-{STATECODE}-{SLUG}` | `NG-LA-LEKKI` |

**Naming rules:**

- `countryCode` — always ISO 3166-1 alpha-2, always uppercase, exactly 2 letters. No exceptions, no made-up codes.
- `stateCode` — uppercase, alphanumeric only (no spaces, no hyphens, no punctuation), short (2–4 characters recommended). Must be unique *within its country*, not globally — `NG-LA` and `US-LA` (Louisiana) can coexist without conflict since the country prefix disambiguates them.
- `SLUG` (used in location IDs) — uppercase, alphanumeric plus hyphens only, derived from `name` by: uppercasing, replacing spaces with hyphens, stripping punctuation. E.g. "Victoria Island" → `VICTORIA-ISLAND`, so its `locationId` is `NG-LA-VICTORIA-ISLAND`.
- Document IDs are permanent once created. Renaming a place changes its `name` field, never its document ID — this is exactly what the `status`/soft-archive model exists to support without breaking references from `vendors.businessLocation`.

---

## 3. Required vs. Optional Fields

Every field listed in Section 1 is **required** — there are no optional fields in this v1 spec. This is a deliberate choice: a small, fully-required schema is easier to validate, easier to reason about, and prevents "sometimes this field exists, sometimes it doesn't" bugs downstream in the frontend. If a genuinely optional field is needed later (e.g. `wikiDataId`), it should be added as a new versioned field with a documented default for existing records, not introduced silently.

**Field purpose summary:**

| Field | Purpose |
|---|---|
| `*Id` / `*Code` | Stable machine identifier, used for document IDs and foreign-key-style references |
| `name` | Human-readable display value, shown in the UI |
| `normalizedName` | Lowercase comparison key, used to detect duplicates and for case-insensitive search |
| `status` | Controls visibility/selectability without ever deleting the record |
| `sortOrder` | Controls dropdown/list display order independent of alphabetical sort |
| `createdAt` / `updatedAt` | Audit trail, consistent with the standard used across every other the platform collection |

---

## 4. Validation Rules

These are the rules `npm run validate:locations` enforces before anything is imported.

1. **Allowed `status` values:** exactly `"active"`, `"inactive"`, or `"archived"`. Any other value fails validation.
2. **Duplicate ID prevention:** no two records at the same level may share a document ID (`countryCode`, `stateId`, or `locationId`).
3. **Duplicate normalized name prevention (scoped):**
   - No two countries may share a `normalizedName`.
   - No two states within the *same country* may share a `normalizedName` (two different countries can each have a state called "Lagos" without conflict).
   - No two locations within the *same state* may share a `normalizedName`.
4. **Parent relationship validation:**
   - Every `states` record's `countryCode` must reference an existing `countries` document.
   - Every `locations` record's `stateId` must reference an existing `states` document, and that state's `countryCode` must match the location's own `countryCode`.
5. **Code format validation:**
   - `countryCode` — exactly 2 uppercase letters.
   - `stateCode` — uppercase alphanumeric, no spaces/punctuation, 2–4 characters recommended.
   - `dialCode` — must start with `+` followed by digits only.
   - `currencyCode` — exactly 3 uppercase letters.
   - `timeZone` (on Location records) — must be a valid IANA timezone identifier (e.g. `Africa/Lagos`, `America/Toronto`, `Australia/Perth`) — validated against the standard IANA tz database list, not freeform text. Required on every location record, no default or inherited value permitted.
6. **Slug rules:** `slug` must be uppercase alphanumeric-plus-hyphen only, must match the hyphenated form of `name`, and must be consistent with the trailing segment of `locationId`.
7. **Required field check:** every field in the schema (Section 1) must be present and non-empty on every record. No nulls, no missing keys.

Validation failures are reported per-record with a specific reason (e.g. `"NG-LA-LEKKI: duplicate normalizedName 'lekki' within state NG-LA"`), never a generic pass/fail.

---

## 5. Seed/Import JSON Format

### 5.1 File layout

```
scripts/location-seeds/
  countries.json
  states/
    NG.json
    US.json
    ...
  locations/
    NG-LA.json
    NG-FC.json
    ...
```

- `countries.json` — a single array containing every country.
- `states/{COUNTRYCODE}.json` — one file per country, containing an array of that country's states.
- `locations/{stateId}.json` — one file per state, containing an array of that state's cities/areas.

The import script reads every file present in `states/` and `locations/` automatically — it does not hardcode a list of expected filenames. Adding a new country means adding new files; no code changes required.

### 5.2 `countries.json` format

```json
[
  {
    "countryCode": "NG",
    "name": "Nigeria",
    "normalizedName": "nigeria",
    "dialCode": "+234",
    "currencyCode": "NGN",
    "currencySymbol": "₦",
    "flagEmoji": "🇳🇬",
    "defaultLocale": "en-NG",
    "status": "active",
    "sortOrder": 1
  }
]
```

(`createdAt`/`updatedAt` are never included in the source JSON — the import script sets these automatically via `FieldValue.serverTimestamp()`.)

### 5.3 `states/NG.json` format

```json
[
  {
    "stateId": "NG-LA",
    "countryCode": "NG",
    "stateCode": "LA",
    "name": "Lagos",
    "normalizedName": "lagos",
    "type": "state",
    "status": "active",
    "sortOrder": 1
  },
  {
    "stateId": "NG-FC",
    "countryCode": "NG",
    "stateCode": "FC",
    "name": "Federal Capital Territory",
    "normalizedName": "federal capital territory",
    "type": "territory",
    "status": "active",
    "sortOrder": 2
  }
]
```

### 5.4 `locations/NG-LA.json` format

```json
[
  {
    "locationId": "NG-LA-LEKKI",
    "countryCode": "NG",
    "stateId": "NG-LA",
    "stateCode": "LA",
    "name": "Lekki",
    "normalizedName": "lekki",
    "slug": "LEKKI",
    "locationType": "area",
    "timeZone": "Africa/Lagos",
    "status": "active",
    "sortOrder": 1
  },
  {
    "locationId": "NG-LA-VICTORIA-ISLAND",
    "countryCode": "NG",
    "stateId": "NG-LA",
    "stateCode": "LA",
    "name": "Victoria Island",
    "normalizedName": "victoria island",
    "slug": "VICTORIA-ISLAND",
    "locationType": "area",
    "timeZone": "Africa/Lagos",
    "status": "active",
    "sortOrder": 2
  }
]
```

---

## 6. Import Workflow

**Step 1 — Create the country JSON.**
Add or update the entry for the new country in `scripts/location-seeds/countries.json`.

**Step 2 — Create the state/province JSON.**
Create `scripts/location-seeds/states/{COUNTRYCODE}.json` containing every state/province for that country.

**Step 3 — Create the Area/City JSON.**
For each state added in Step 2, create `scripts/location-seeds/locations/{stateId}.json` containing that state's cities/areas. It is fine to start with only a few major cities per state and expand the file later — the import script is safe to rerun.

**Step 4 — Run the validation command.**
```bash
npm run validate:locations
```
This checks every rule in Section 4 against every file in `location-seeds/`, without writing anything to Firestore. Fix any reported errors before continuing.

**Step 5 — Run the seed/import command.**
```bash
npm run import:locations
```
This writes/updates Firestore based on the validated seed files. Safe to rerun at any time — existing records are updated only if a field actually changed (`createdAt` is preserved, `updatedAt` refreshes only on real changes); new records are created; records that exist in Firestore but were removed from the seed files are **not** deleted, only flagged in the summary output for manual review.

**Step 6 — Verify the import.**
The import command prints a summary:
```
Countries:  1 created, 0 updated, 0 skipped, 0 failed
States:     2 created, 0 updated, 0 skipped, 0 failed
Locations: 14 created, 0 updated, 0 skipped, 0 failed
```
Cross-check this against what you expected to add. Optionally spot-check a few documents directly in the Firestore console to confirm field values look correct.

---

## 7. Developer Guide — Complete Example (Nigeria)

This walks through the full process end to end using Nigeria as the worked example.

**1. Add Nigeria to `countries.json`:**
```json
{
  "countryCode": "NG",
  "name": "Nigeria",
  "normalizedName": "nigeria",
  "dialCode": "+234",
  "currencyCode": "NGN",
  "currencySymbol": "₦",
  "flagEmoji": "🇳🇬",
  "defaultLocale": "en-NG",
  "status": "active",
  "sortOrder": 1
}
```

**2. Create `states/NG.json`** with Nigeria's states, e.g.:
```json
[
  { "stateId": "NG-LA", "countryCode": "NG", "stateCode": "LA", "name": "Lagos", "normalizedName": "lagos", "type": "state", "status": "active", "sortOrder": 1 },
  { "stateId": "NG-FC", "countryCode": "NG", "stateCode": "FC", "name": "Federal Capital Territory", "normalizedName": "federal capital territory", "type": "territory", "status": "active", "sortOrder": 2 },
  { "stateId": "NG-RI", "countryCode": "NG", "stateCode": "RI", "name": "Rivers", "normalizedName": "rivers", "type": "state", "status": "active", "sortOrder": 3 }
]
```

**3. Create `locations/NG-LA.json`** for Lagos's cities/areas:
```json
[
  { "locationId": "NG-LA-LAGOS", "countryCode": "NG", "stateId": "NG-LA", "stateCode": "LA", "name": "Lagos", "normalizedName": "lagos", "slug": "LAGOS", "locationType": "city", "timeZone": "Africa/Lagos", "status": "active", "sortOrder": 1 },
  { "locationId": "NG-LA-IKEJA", "countryCode": "NG", "stateId": "NG-LA", "stateCode": "LA", "name": "Ikeja", "normalizedName": "ikeja", "slug": "IKEJA", "locationType": "area", "timeZone": "Africa/Lagos", "status": "active", "sortOrder": 2 },
  { "locationId": "NG-LA-LEKKI", "countryCode": "NG", "stateId": "NG-LA", "stateCode": "LA", "name": "Lekki", "normalizedName": "lekki", "slug": "LEKKI", "locationType": "area", "timeZone": "Africa/Lagos", "status": "active", "sortOrder": 3 }
]
```
(And similarly `locations/NG-FC.json`, `locations/NG-RI.json` for the other states — every location record carries its own `timeZone`, even when, as in Nigeria's case, it's the same value across the whole country.)

**4. Validate:**
```bash
npm run validate:locations
```
Expected output on success:
```
✓ 1 country validated
✓ 3 states validated
✓ 14 locations validated
No errors found.
```

**5. Import:**
```bash
npm run import:locations
```
```
Countries:  1 created, 0 updated, 0 skipped, 0 failed
States:     3 created, 0 updated, 0 skipped, 0 failed
Locations: 14 created, 0 updated, 0 skipped, 0 failed
```

**6. Verify:** Check `countries/NG`, `states/NG-LA`, and `locations/NG-LA-LEKKI` in the Firestore console. Confirm `createdAt`/`updatedAt` are populated and `status: "active"`.

**To add a second country later (e.g. Ghana):** repeat steps 1–6 with `GH` in place of `NG` — add its entry to `countries.json`, create `states/GH.json`, create the relevant `locations/GH-*.json` files, validate, import. No code changes required at any point; this entire process is data-only.

---

## 8. Downstream Item — Vendor Store Status / Business Hours Schema

This is not part of the location catalogue itself, but depends directly on `Location.timeZone` (Section 1.3), so it's documented here for continuity. This fixes the previously-flagged gap: the vendor document has no `timezone` field and no working `isOpenNow` calculation.

**Source of truth principle:** the device clock/timezone is a **setup-time suggestion only**, never authoritative. Vendors travel and change device settings; none of that should affect what customers see as the vendor's real business hours. Server time is always authoritative for evaluating current status.

### 8.1 Vendor fields

```typescript
type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

interface DayHours {
  closed: boolean;
  periods: Array<{
    start: string;     // local wall-clock time, HH:mm, e.g. "09:00" — inclusive
    end: string;        // local wall-clock time, HH:mm, e.g. "18:00", OR "24:00" — exclusive.
                         // "24:00" is the only permitted value beyond the normal 00:00–23:59 range,
                         // used exclusively to represent a period ending at midnight (see Section 8.6).
  }>;
}

// Added to vendors/{vendorId}
{
  businessLocation: {
    countryCode: string;
    stateId: string;
    locationId: string;
    timeZone: string;          // copied from the selected Location.timeZone at onboarding time
  };
  businessTimeZone: string;    // snapshot of businessLocation.timeZone — see note below
  storeStatus: {
    mode: "business_hours" | "manual";
    manualStatus: "open" | "closed";   // used only when mode === "manual"
    timeZone: string;                   // authoritative timezone for evaluating weeklyHours below
    weeklyHours: {
      // All seven keys are required on every vendor document — no partial weeks.
      // A day with no service is represented as { closed: true, periods: [] }, not an absent key.
      monday: DayHours;
      tuesday: DayHours;
      wednesday: DayHours;
      thursday: DayHours;
      friday: DayHours;
      saturday: DayHours;
      sunday: DayHours;
    };
    updatedAt: Timestamp;              // set on any change to mode, weeklyHours, or timeZone
    manualStatusChangedAt: Timestamp;  // set whenever manualStatus is toggled — lets the UI show "closed since..."
    timeZoneConfirmedAt: Timestamp;    // set when the vendor explicitly confirms/corrects storeStatus.timeZone
                                        // (onboarding or after a location-change prompt, per Section 8.2)
  };
}
```

**Why `weeklyHours` is now a fixed seven-key object, not `[weekday: string]`:** an indexed string type allowed any key at all, including typos or missing days with no validation-time signal. A fixed `Weekday` union with all seven keys required means every vendor document always has a complete week, and "day not configured" is impossible to represent by accident — a day with no service is explicit (`closed: true, periods: []`), not an absent key that evaluation logic has to special-case.

**Why both `businessTimeZone` and `storeStatus.timeZone` exist:** `businessTimeZone` is the onboarding-derived snapshot tied to the vendor's selected location. `storeStatus.timeZone` is the value actually used for open/closed evaluation, and the vendor can confirm or correct it independently if it's ever wrong for their specific situation — it does not silently follow `businessLocation` if the vendor overrides it. They typically match, but the system does not assume they always will.

**Why `weeklyHours` supports multiple periods per day:** the frontend already allows schedules with a midday break (e.g. Monday 9:00 AM–6:00 PM, then 6:00 PM–9:00 PM as a second period) — see the Store Status screen. `periods[]` is an array specifically to support this, not a single start/end pair.

**Why hours are stored as local wall-clock strings, not fixed timestamps:** a fixed UTC timestamp for "9:00 AM" only stays correct for one specific date and breaks across daylight-saving transitions. Storing `"09:00"` as a plain local time, always interpreted through the vendor's IANA `timeZone`, means the correct UTC instant is recalculated correctly on every single day, including across DST changes, without ever needing to touch the stored data.

### 8.2 How `Location.timeZone` propagates to the vendor, and what happens on a location change

**At initial onboarding:**
1. Vendor selects a location from the catalogue (country → state → area/city).
2. That `Location.timeZone` value is copied into both `businessLocation.timeZone` and `businessTimeZone` on the vendor document, and also seeds `storeStatus.timeZone` as its starting value.
3. The vendor may confirm or override `storeStatus.timeZone` independently at this point (see Section 8.1) — the copy is a starting point, not a permanent lock.

**After an approved business-location change (via the existing Account Change Request → Admin Approval workflow, per the earlier product decision that business-location edits post-verification go through admin review, not a direct self-service edit):**
1. Once admin-approved, the new `Location.timeZone` is re-copied into `businessLocation.timeZone` and `businessTimeZone`, overwriting the previous snapshot.
2. `storeStatus.timeZone` is **not** silently overwritten. If the vendor had already confirmed/customized `storeStatus.timeZone` and the new location's timezone differs from it, the vendor is prompted to review and re-confirm their business hours' timezone rather than having it changed underneath them — since `weeklyHours` values are stored as wall-clock local time, a silent timezone change would shift their actual real-world open/closed hours without the vendor realizing it.
3. If `storeStatus.timeZone` had never been manually customized (still equal to the prior `businessTimeZone` snapshot), it updates automatically to match the new location's timezone, since there was no vendor-specific override to preserve.

### 8.3 Evaluation logic (`business_hours` mode)

1. Read trusted current server time — **authoritative**, never device time. Device time/timezone is suggestion/display only, exactly as at onboarding (Section 8.7).
2. Convert it into the vendor's `storeStatus.timeZone`.
3. Determine the resulting local weekday and time-of-day.
4. Look up that weekday in `weeklyHours`; if `closed: true`, vendor is closed.
5. Otherwise, check whether the current local time falls within any `periods[]` entry for that day. **Boundaries are start-inclusive, end-exclusive**: a period `"09:00"`–`"18:00"` is open at exactly `09:00:00` and closed at exactly `18:00:00`. Open if the current time falls within any period under this rule, closed otherwise.

### 8.4 Evaluation logic (`manual` mode)

`storeStatus.manualStatus` is used directly, no schedule evaluation. This overrides the regular weekly schedule entirely until the vendor switches `mode` back to `"business_hours"`.

### 8.5 Server-side enforcement at order creation

`isOpenNow` (or the equivalent value shown in discovery/storefront UI) must never be trusted as the sole gate on whether an order can actually be placed. **Order creation must independently re-evaluate effective Store Status at the moment of creation**, using the same logic as Section 8.3/8.4 against trusted server time, not a client-supplied or cached value. If the store is closed at that exact moment (by schedule or manual override), order creation must reject with a clear error rather than silently succeeding. This closes the gap where a customer's app displayed "open" a few seconds or minutes earlier, the store closed in the interim, and the order would otherwise be created as if nothing changed.

### 8.6 Validation rules for `weeklyHours`

1. **Time format:** `start` must match `HH:mm` in 24-hour format (`"09:00"`), range `00:00`–`23:59`. `end` must match the same format **or** the special value `"24:00"`, and no other value outside the normal range is permitted. Any other format is rejected.
2. **Valid time range:** hours `00`–`23` (or exactly `24:00` for `end`), minutes `00`–`59`. `"25:00"` or `"09:70"` are rejected.
3. **`end` after `start` within a period:** each period's `end` must be strictly later than its `start` on the same day (per the start-inclusive/end-exclusive rule in Section 8.3). **True overnight periods within a single entry (e.g. one period spanning `"22:00"`–`"02:00"`) remain unsupported for MVP and are rejected at validation.** Late-night hours are instead represented across two adjacent day entries using `"24:00"` as the boundary: e.g. a vendor open until 2 AM enters `{ start: "22:00", end: "24:00" }` on the first day and `{ start: "00:00", end: "02:00" }` on the following day. `"24:00"` is only valid as an `end` value, never as `start`.
4. **No overlapping periods within the same day:** for a given weekday, no two `periods[]` entries may overlap under the start-inclusive/end-exclusive rule (e.g. `"09:00"`–`"18:00"` and `"12:00"`–`"14:00"` on the same day is invalid — the second period is already contained in the first). Adjacent-but-not-overlapping periods (e.g. `"09:00"`–`"13:00"` then `"14:00"`–`"18:00"`, representing a lunch closure) are valid, and a period ending exactly where the next begins (e.g. `"09:00"`–`"12:00"` then `"12:00"`–`"18:00"`) is also valid under this rule, since the boundary is exclusive on one side and inclusive on the other.
5. **Empty periods on an open day:** if `closed: false` for a weekday, `periods[]` must contain at least one entry — an "open" day with zero periods is rejected as invalid, since it's ambiguous (should be modeled as `closed: true` instead).
6. **`storeStatus.timeZone` and `businessTimeZone`:** both must be valid IANA timezone identifiers, same validation as `Location.timeZone` (Section 4).
7. **All seven `Weekday` keys required:** `monday` through `sunday` must all be present on every vendor's `weeklyHours` object — no partial weeks.

### 8.7 Onboarding flow

1. Vendor selects their business location (country → state → area/city) from the location catalogue (Sections 1–7 of this document).
2. The selected `Location.timeZone` is copied into `businessLocation.timeZone` and `businessTimeZone`.
3. The device's local timezone may be shown as a **suggested** starting value if it differs from the location-derived one, purely as a convenience — never auto-applied without vendor confirmation.
4. Vendor confirms (or corrects) `storeStatus.timeZone` before completing onboarding — this sets `timeZoneConfirmedAt`.

### 8.8 Technical note on this section's boundary

Unlike the location catalogue (Sections 1–7), this schema is not authored via seed files — it's populated per-vendor, per-onboarding, through the app itself. This is a technical distinction only: the location catalogue is static reference data maintained outside the running application, while `storeStatus` and related vendor fields are live application state written by users through normal product flows.

---

This specification uses standard, publicly published identifier systems where they exist: ISO 3166-1 (country codes), BCP 47 (locale tags), and the IANA Time Zone Database (timezone identifiers). Using these standards is intentional and correct — they are the accepted, stable references for this kind of data, and reinventing them would only introduce inconsistency. What this specification does not do is depend on any third-party API, dataset, or runtime service to operate. the platform owns and maintains its own runtime location catalogue — every `countries`, `states`, and `locations` document is authored by the platform and stored in the platform's own Firestore instance. The application never calls an external service to resolve a country, state, city, or timezone at runtime; it reads only from data the platform has already authored and imported. This is intentional and should remain true for all future countries added to the system.


## Country Status

active
• Appears in signup
• Vendors and customers may register
• Marketplace operates normally

inactive
• Hidden from new registration
• Existing vendors/customers continue to access their accounts
• New onboarding disabled

archived
• Country has been retired
• Hidden from all dropdowns
• Retained only for historical references
• Never physically deleted