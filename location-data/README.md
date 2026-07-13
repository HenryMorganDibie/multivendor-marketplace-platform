# the platform Location Data

This folder is the platform's canonical, self-authored location catalogue — every **Country**, **State/Province**, and **Area/City** the app knows about. Nothing here comes from a third-party API or dataset; every record is written by hand (or generated from public reference sources) and reviewed before import.

This is a quick reference. **`THE PLATFORM LOCATION SPEC v1.5.md` is the full canonical spec** — schema, ID rules, validation rules, and the complete import workflow all live there. If anything here and the spec ever disagree, the spec wins.

This folder does **not** cover vendor Store Status / business hours (Section 8 of the spec) — that's a separate, per-vendor schema populated through the app itself, not through seed files. It's mentioned here only because it depends on the `timeZone` field defined below.

---

## Schema

Every field below is **required** on every record — there are no optional fields. `createdAt` and `updatedAt` are **never** included in these JSON files; the import script sets both automatically (`FieldValue.serverTimestamp()`) when a record is written to Firestore.

### Country

```typescript
interface CountryDocument {
  countryCode: string;        // ISO 3166-1 alpha-2, uppercase, e.g. "NG" — this is the document ID
  name: string;                // official common name, e.g. "Nigeria"
  normalizedName: string;      // lowercase, trimmed, no diacritics, e.g. "nigeria"
  dialCode: string;            // international calling code with leading "+", e.g. "+234"
  currencyCode: string;        // ISO 4217, e.g. "NGN"
  currencySymbol: string;      // e.g. "₦"
  flagEmoji: string;           // Unicode flag emoji, e.g. "🇳🇬"
  defaultLocale: string;       // BCP 47 tag, e.g. "en-NG"
  status: "active" | "inactive" | "archived";  // gates signup/onboarding at the country level —
                                                // see "Country Status" in the spec for exact behavior per value
  sortOrder: number;           // integer, controls display order in dropdowns
}
```

**Country `status` has real behavioral meaning, not just display:** `active` = open for signup/onboarding, `inactive` = existing accounts keep working but no new registration, `archived` = fully retired, hidden everywhere, never deleted. Full detail in the spec's "Country Status" section.

### State / Province

```typescript
interface StateDocument {
  stateId: string;             // "{countryCode}-{stateCode}", e.g. "NG-LA" — this is the document ID
  countryCode: string;         // must reference an existing country
  stateCode: string;           // short code, unique within the country, e.g. "LA"
  name: string;                // e.g. "Lagos"
  normalizedName: string;      // lowercase, trimmed, e.g. "lagos"
  type: "state" | "province" | "region" | "territory";
  status: "active" | "inactive" | "archived";
  sortOrder: number;
}
```

**Timezone does not live here.** Countries and states can span multiple time zones (the US, Canada, Australia, Russia, and others each do), so state-level or country-level timezone can't be relied on. Timezone is required on **Area/City** records only — see below.

### Area / City

```typescript
interface LocationDocument {
  locationId: string;          // "{countryCode}-{stateCode}-{SLUG}", e.g. "NG-LA-LEKKI" — this is the document ID
  countryCode: string;         // denormalized from the parent state
  stateId: string;             // must reference an existing state
  stateCode: string;           // denormalized from the parent state
  name: string;                // e.g. "Lekki"
  normalizedName: string;      // lowercase, trimmed, e.g. "lekki"
  slug: string;                // URL/ID-safe form, e.g. "LEKKI"
  locationType: "city" | "area" | "district" | "town";
  timeZone: string;            // REQUIRED HERE — IANA identifier, e.g. "Africa/Lagos", "America/Toronto".
                                // This is the authoritative timezone source for this location. It's what
                                // populates a vendor's businessLocation.timeZone / businessTimeZone when
                                // this location is selected during onboarding.
  status: "active" | "inactive" | "archived";
  sortOrder: number;
}
```

`timeZone` lives on Area/City specifically — not Country, not State — because it's the only level granular enough to be correct everywhere. Every location record needs its own value, even in a country like Nigeria where it happens to be the same string everywhere.

---

## Document ID convention

| Level | Format | Example |
|---|---|---|
| Country | `{COUNTRYCODE}` | `NG` |
| State/Province | `{COUNTRYCODE}-{STATECODE}` | `NG-LA` |
| Area/City | `{COUNTRYCODE}-{STATECODE}-{SLUG}` | `NG-LA-LEKKI` |

IDs are permanent once created — a rename changes `name`, never the document ID. Full ID/slug rules are in the spec (Section 2).

---

## Where files go

| File | Contains |
|---|---|
| `countries.json` | A single array with **every** country. One file, always. |
| `states/{COUNTRYCODE}.json` | One file per country, containing that country's states/provinces as an array. E.g. `states/NG.json`. |
| `locations/{stateId}.json` | One file per state, containing that state's cities/areas as an array. E.g. `locations/NG-LA.json`. |

Adding a new country is purely data: add its entry to `countries.json`, add `states/{CODE}.json`, add the relevant `locations/{stateId}.json` files. No code changes required.

---

## Worked example — Nigeria

**`countries.json`:**
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

**`states/NG.json`:**
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
  }
]
```

**`locations/NG-LA.json`:**
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
  }
]
```

---

## `createdAt` / `updatedAt`

Never include these in files in this folder. They're set automatically by the import script when a record is written to Firestore (`createdAt` set once, `updatedAt` refreshed only when a field actually changes on a rerun).

---

## Validation, before you ask

`npm run validate:locations` and `npm run import:locations` aren't implemented yet — this folder is scaffolding only for now. Once they exist, validation will enforce (per the spec, Section 4): allowed `status` values, no duplicate IDs, no duplicate `normalizedName` within the same parent, valid parent references (state → country, location → state), code formats (`countryCode` 2 letters, `currencyCode` 3 letters, `dialCode` starts with `+`), and that every `timeZone` is a real IANA identifier.

## One more thing worth knowing

Section 8 of the spec defines the **vendor Store Status / business hours** schema (`weeklyHours`, timezone format `HH:mm`, the start-inclusive/end-exclusive boundary rule, the overlapping-period and no-true-overnight-entry rules, server-side re-evaluation at order creation). None of that applies to files in this folder — it's a separate, per-vendor schema populated live through the app, not seed data — but it's the reason `timeZone` on your Area/City records matters: it's what feeds a vendor's business hours evaluation once they select a location during onboarding. See the spec directly if you're working on that part.
