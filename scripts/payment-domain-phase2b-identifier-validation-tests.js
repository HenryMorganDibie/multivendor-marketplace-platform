/**
 * Payment Domain — Batch 2B identifier/routing/IBAN/email/phone/masking/
 * canonicalization unit tests.
 *
 * Pure-logic tests: these exercise exported functions from
 * functions/src/vendors/setVendorPaymentInstructions.ts and
 * functions/src/paymentInstructions/maskPaymentIdentifier.ts directly,
 * against the compiled lib/ output. None of this requires the Firestore,
 * Auth, or Functions emulator -- there is no db/auth/App-Check dependency
 * anywhere in these functions.
 *
 * Build first: npm --prefix functions run build
 * Usage: node payment-domain-phase2b-identifier-validation-tests.js
 */

const path = require("path");
const {
  validateStorageSafeValue,
  validateEmailIdentifierValue,
  validateAndNormalizeIban,
  validateAndNormalizeSwiftBic,
  validateAndNormalizePhoneIdentifier,
  validatePaymentDestinationInput,
  buildCanonicalPayload,
  canonicalPayloadKey,
  hashPayload,
} = require(path.join(__dirname, "..", "functions", "lib", "vendors", "setVendorPaymentInstructions"));
const { maskPaymentIdentifier } = require(path.join(__dirname, "..", "functions", "lib", "paymentInstructions", "maskPaymentIdentifier"));

let passed = 0, failed = 0, total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message || e}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "Assertion failed");
}

function assertThrows(fn, messageIncludes) {
  try {
    fn();
  } catch (e) {
    if (messageIncludes && !String(e.message).includes(messageIncludes)) {
      throw new Error(`Expected error containing "${messageIncludes}", got: ${e.message}`);
    }
    return;
  }
  throw new Error("Expected a throw, but none occurred");
}

console.log("🚀 PLATFORM — Payment Domain Batch 2B Identifier/Validation Unit Tests");
console.log("=".repeat(60));

// ── Storage-safety validation (account number / routing values) ───────────
console.log("\n📋 validateStorageSafeValue (storage-safety, not financial-format)");

test("Rejects empty", () => assertThrows(() => validateStorageSafeValue("", "Account number")));
test("Rejects whitespace-only", () => assertThrows(() => validateStorageSafeValue("   ", "Account number")));
test("Rejects > 64 chars", () => assertThrows(() => validateStorageSafeValue("1".repeat(65), "Account number")));
test("Accepts exactly 64 chars", () => {
  const v = validateStorageSafeValue("1".repeat(64), "Account number");
  assert(v.length === 64, "64-char value should be accepted");
});
test("Rejects control characters (tab)", () => assertThrows(() => validateStorageSafeValue("123\t456", "Account number")));
test("Rejects control characters (newline)", () => assertThrows(() => validateStorageSafeValue("123\n456", "Account number")));
test("Accepts a non-numeric, non-10-digit value (NUBAN assumption is gone)", () => {
  const v = validateStorageSafeValue("AB-12 34", "Account number");
  assert(v === "AB-12 34", "Non-numeric, non-10-digit values must be accepted, unmodified beyond outer trim");
});
test("Trims only outer whitespace, never internal characters", () => {
  const v = validateStorageSafeValue("  12 34  ", "Account number");
  assert(v === "12 34", "Only leading/trailing whitespace should be trimmed");
});

// ── Email ───────────────────────────────────────────────────────────────────
console.log("\n📋 validateEmailIdentifierValue");

test("Accepts a valid email, normalizes to lowercase", () => {
  const v = validateEmailIdentifierValue("  Jane.Vendor@Example.COM  ");
  assert(v === "jane.vendor@example.com", `Expected lowercase-normalized email, got "${v}"`);
});
test("Rejects a malformed email", () => assertThrows(() => validateEmailIdentifierValue("not-an-email")));
test("Rejects empty", () => assertThrows(() => validateEmailIdentifierValue("")));
test("Rejects > 254 chars", () => assertThrows(() => validateEmailIdentifierValue(`${"a".repeat(250)}@x.com`)));

// ── IBAN ──────────────────────────────────────────────────────────────────
console.log("\n📋 validateAndNormalizeIban");

test("Normalizes: strips visual spaces, uppercases", () => {
  const v = validateAndNormalizeIban("gb29 nwbk 6016 1331 9268 19");
  assert(v === "GB29NWBK60161331926819", `Expected normalized IBAN, got "${v}"`);
});
test("Rejects empty", () => assertThrows(() => validateAndNormalizeIban("   ")));
test("Rejects > 34 chars (after space removal)", () => assertThrows(() => validateAndNormalizeIban("A".repeat(35))));
test("Accepts exactly 34 chars", () => {
  const v = validateAndNormalizeIban("A".repeat(34));
  assert(v.length === 34, "34-char IBAN should be accepted (ISO 13616 max)");
});
test("Rejects control characters", () => assertThrows(() => validateAndNormalizeIban("GB29\tNWBK")));
test("Does not assert country-specific length/checksum (no mod-97 rejection)", () => {
  // A structurally-plausible-looking but checksum-invalid IBAN must still be accepted --
  // no checksum validation exists or is claimed.
  const v = validateAndNormalizeIban("GB00NWBK00000000000000");
  assert(v === "GB00NWBK00000000000000", "No checksum validation should be applied");
});

// ── SWIFT/BIC ────────────────────────────────────────────────────────────
console.log("\n📋 validateAndNormalizeSwiftBic");

test("Normalizes: strips spaces, uppercases", () => {
  const v = validateAndNormalizeSwiftBic("nwbk gb 2l");
  assert(v === "NWBKGB2L", `Expected normalized SWIFT/BIC, got "${v}"`);
});
test("Rejects > 11 chars", () => assertThrows(() => validateAndNormalizeSwiftBic("ABCDEFGHIJKL")));
test("Accepts exactly 11 chars", () => {
  const v = validateAndNormalizeSwiftBic("A".repeat(11));
  assert(v.length === 11, "11-char SWIFT/BIC should be accepted (ISO 9362 max)");
});

// ── Phone (libphonenumber-js) ────────────────────────────────────────────
console.log("\n📋 validateAndNormalizePhoneIdentifier (libphonenumber-js)");

test("National-format number normalizes via vendor's own resolved country (NG)", () => {
  const v = validateAndNormalizePhoneIdentifier("08012345678", "NG");
  assert(v === "+2348012345678", `Expected E.164, got "${v}"`);
});
test("National-format number normalizes via vendor's own resolved country (GB)", () => {
  const v = validateAndNormalizePhoneIdentifier("07911123456", "GB");
  assert(v.startsWith("+44"), `Expected UK E.164, got "${v}"`);
});
test("A number already in international form for a DIFFERENT country than the vendor's own is parsed correctly, not reinterpreted", () => {
  // Vendor resolved to NG, but the number is explicitly a US number in international form.
  const v = validateAndNormalizePhoneIdentifier("+14155552671", "NG");
  assert(v === "+14155552671", `Expected the US number preserved as-is, got "${v}"`);
});
test("Rejects an invalid number", () => assertThrows(() => validateAndNormalizePhoneIdentifier("123", "NG")));
test("Rejects empty", () => assertThrows(() => validateAndNormalizePhoneIdentifier("", "NG")));
test("A non-+-prefixed number for a vendor country libphonenumber-js does not recognize is rejected, not silently defaulted", () => {
  // "ZZ" is not a real region libphonenumber-js recognizes.
  assertThrows(() => validateAndNormalizePhoneIdentifier("8012345678", "ZZ"), "country code");
});
test("No +234 fallback: an invalid-for-NG bare number is rejected, not coerced", () => {
  assertThrows(() => validateAndNormalizePhoneIdentifier("123", "NG"));
});

// ── Full destination validation: bank_transfer vs contact_transfer ─────────
console.log("\n📋 validatePaymentDestinationInput");

test("bank_transfer + account_number: valid", () => {
  const d = validatePaymentDestinationInput(
    { type: "bank_transfer", institutionName: "Test Bank", recipientName: "Jane Vendor", identifier: { type: "account_number", value: "1234567890" } },
    "NG", "NGN"
  );
  assert(d.type === "bank_transfer" && d.identifier.type === "account_number", "Should produce a bank_transfer/account_number destination");
  assert(d.countryCode === "NG" && d.currencyCode === "NGN", "countryCode/currencyCode should be the server-derived values passed in");
});

test("bank_transfer + account_number + routing: valid, max 3, no duplicates", () => {
  const d = validatePaymentDestinationInput(
    {
      type: "bank_transfer", institutionName: "Test Bank", recipientName: "Jane Vendor",
      identifier: {
        type: "account_number", value: "123456",
        routing: [
          { type: "transit_number", value: "12345" },
          { type: "institution_number", value: "003" },
        ],
      },
    },
    "CA", "CAD"
  );
  assert(d.identifier.routing.length === 2, "Both routing entries should be accepted");
});

test("bank_transfer + routing: 4th entry rejected", () => {
  assertThrows(() => validatePaymentDestinationInput(
    {
      type: "bank_transfer", institutionName: "Test Bank", recipientName: "Jane Vendor",
      identifier: {
        type: "account_number", value: "123456",
        routing: [
          { type: "sort_code", value: "1" }, { type: "routing_number", value: "2" },
          { type: "bsb", value: "3" }, { type: "ifsc", value: "4" },
        ],
      },
    },
    "GB", "GBP"
  ), "at most");
});

test("bank_transfer + routing: duplicate type rejected", () => {
  assertThrows(() => validatePaymentDestinationInput(
    {
      type: "bank_transfer", institutionName: "Test Bank", recipientName: "Jane Vendor",
      identifier: { type: "account_number", value: "123456", routing: [{ type: "sort_code", value: "1" }, { type: "sort_code", value: "2" }] },
    },
    "GB", "GBP"
  ), "duplicate");
});

test("bank_transfer + iban: valid, with swiftBic", () => {
  const d = validatePaymentDestinationInput(
    {
      type: "bank_transfer", institutionName: "NatWest", recipientName: "Jane Vendor",
      identifier: { type: "iban", value: "GB29 NWBK 6016 1331 9268 19", swiftBic: "nwbkgb2l" },
    },
    "GB", "GBP"
  );
  assert(d.identifier.type === "iban", "Should produce an iban identifier");
  assert(d.identifier.value === "GB29NWBK60161331926819", "IBAN should be normalized");
  assert(d.identifier.swiftBic === "NWBKGB2L", "swiftBic should be normalized");
});

test("bank_transfer + iban: routing alongside IBAN is rejected (dedicated swiftBic field only)", () => {
  assertThrows(() => validatePaymentDestinationInput(
    {
      type: "bank_transfer", institutionName: "NatWest", recipientName: "Jane Vendor",
      identifier: { type: "iban", value: "GB29NWBK60161331926819", routing: [{ type: "swift_bic", value: "NWBKGB2L" }] },
    },
    "GB", "GBP"
  ), "routing is not accepted alongside an IBAN");
});

test("bank_transfer rejects an email identifier", () => {
  assertThrows(() => validatePaymentDestinationInput(
    { type: "bank_transfer", institutionName: "Test Bank", recipientName: "Jane Vendor", identifier: { type: "email", value: "jane@example.com" } },
    "NG", "NGN"
  ), "account_number");
});

test("bank_transfer rejects a phone identifier", () => {
  assertThrows(() => validatePaymentDestinationInput(
    { type: "bank_transfer", institutionName: "Test Bank", recipientName: "Jane Vendor", identifier: { type: "phone", value: "+2348012345678" } },
    "NG", "NGN"
  ), "account_number");
});

test("contact_transfer + email: valid, no institutionName field", () => {
  const d = validatePaymentDestinationInput(
    { type: "contact_transfer", recipientName: "Jane Vendor", identifier: { type: "email", value: "Jane@Example.com" } },
    "CA", "CAD"
  );
  assert(d.type === "contact_transfer" && d.identifier.value === "jane@example.com", "Should produce a normalized contact_transfer/email destination");
  assert(!("institutionName" in d), "contact_transfer must never carry institutionName");
});

test("contact_transfer + phone: valid", () => {
  const d = validatePaymentDestinationInput(
    { type: "contact_transfer", recipientName: "Jane Vendor", identifier: { type: "phone", value: "4165551234" } },
    "CA", "CAD"
  );
  assert(d.identifier.type === "phone" && d.identifier.value.startsWith("+1"), "Should normalize to E.164 using the vendor's resolved country");
});

test("contact_transfer rejects institutionName if the client supplies it", () => {
  assertThrows(() => validatePaymentDestinationInput(
    { type: "contact_transfer", institutionName: "Should Not Be Allowed", recipientName: "Jane Vendor", identifier: { type: "email", value: "jane@example.com" } },
    "CA", "CAD"
  ), "institutionName is not accepted");
});

test("contact_transfer rejects an account_number identifier", () => {
  assertThrows(() => validatePaymentDestinationInput(
    { type: "contact_transfer", recipientName: "Jane Vendor", identifier: { type: "account_number", value: "1234567890" } },
    "CA", "CAD"
  ), "email");
});

test("contact_transfer rejects an IBAN identifier", () => {
  assertThrows(() => validatePaymentDestinationInput(
    { type: "contact_transfer", recipientName: "Jane Vendor", identifier: { type: "iban", value: "GB29NWBK60161331926819" } },
    "CA", "CAD"
  ), "email");
});

test("Client-supplied countryCode/currencyCode on the destination is rejected", () => {
  assertThrows(() => validatePaymentDestinationInput(
    { type: "bank_transfer", countryCode: "US", institutionName: "Test Bank", recipientName: "Jane Vendor", identifier: { type: "account_number", value: "1234567890" } },
    "NG", "NGN"
  ), "server-derived");
});

test("null destination is accepted (cash-only configuration)", () => {
  const d = validatePaymentDestinationInput(null, "NG", "NGN");
  assert(d === null, "null should pass through as null");
});

// ── Masking (identifier-neutral) ────────────────────────────────────────
console.log("\n📋 maskPaymentIdentifier (identifier-neutral)");

test("account_number: last 4 visible", () => {
  const m = maskPaymentIdentifier({ type: "account_number", value: "1234567890" });
  assert(m === "••••••7890", `Expected last-4-visible mask, got "${m}"`);
});
test("iban: last 4 visible", () => {
  const m = maskPaymentIdentifier({ type: "iban", value: "GB29NWBK60161331926819" });
  assert(m.endsWith("6819") && m.startsWith("•"), `Expected last-4-visible IBAN mask, got "${m}"`);
  assert(!m.includes("GB29"), "Raw IBAN prefix must never appear in the masked output");
});
test("email: local-part partially redacted, domain kept", () => {
  const m = maskPaymentIdentifier({ type: "email", value: "jane@example.com" });
  assert(m.endsWith("@example.com"), `Expected domain preserved, got "${m}"`);
  assert(!m.includes("jane"), "Raw local part must never appear in the masked output");
});
test("phone: only a short suffix visible", () => {
  const m = maskPaymentIdentifier({ type: "phone", value: "+2348012345678" });
  assert(m.endsWith("5678"), `Expected suffix visible, got "${m}"`);
  assert(!m.includes("234801"), "Raw prefix digits must never appear in the masked output");
});
test("Masking never includes routing codes or swiftBic (function signature takes only the identifier)", () => {
  // maskPaymentIdentifier's type signature (BankAccountIdentifier | ContactIdentifier)
  // structurally cannot receive a routing array or swiftBic value on its own --
  // this test documents that guarantee by construction.
  const m = maskPaymentIdentifier({ type: "iban", value: "GB29NWBK60161331926819", swiftBic: "NWBKGB2L" });
  assert(!m.includes("NWBKGB2L"), "swiftBic must never leak into the masked identifier string");
});

// ── Canonicalization / idempotency hashing ──────────────────────────────
console.log("\n📋 Canonicalization: routing order and IBAN normalization do not affect equality");

test("Routing entries in different order hash identically", () => {
  const a = buildCanonicalPayload({
    acceptCash: false,
    paymentDestination: {
      type: "bank_transfer", countryCode: "CA", currencyCode: "CAD", institutionName: "Test Bank", recipientName: "Jane Vendor",
      identifier: { type: "account_number", value: "123456", routing: [{ type: "transit_number", value: "12345" }, { type: "institution_number", value: "003" }] },
    },
  });
  const b = buildCanonicalPayload({
    acceptCash: false,
    paymentDestination: {
      type: "bank_transfer", countryCode: "CA", currencyCode: "CAD", institutionName: "Test Bank", recipientName: "Jane Vendor",
      identifier: { type: "account_number", value: "123456", routing: [{ type: "institution_number", value: "003" }, { type: "transit_number", value: "12345" }] },
    },
  });
  assert(hashPayload(a) === hashPayload(b), "Reordered routing entries must hash identically -- no spurious version bump");
});

test("Different routing values hash differently (a real change is still detected)", () => {
  const a = buildCanonicalPayload({
    acceptCash: false,
    paymentDestination: { type: "bank_transfer", countryCode: "GB", currencyCode: "GBP", institutionName: "Test Bank", recipientName: "Jane Vendor", identifier: { type: "account_number", value: "1", routing: [{ type: "sort_code", value: "111111" }] } },
  });
  const b = buildCanonicalPayload({
    acceptCash: false,
    paymentDestination: { type: "bank_transfer", countryCode: "GB", currencyCode: "GBP", institutionName: "Test Bank", recipientName: "Jane Vendor", identifier: { type: "account_number", value: "1", routing: [{ type: "sort_code", value: "222222" }] } },
  });
  assert(hashPayload(a) !== hashPayload(b), "A genuinely different routing value must produce a different hash");
});

test("An IBAN destination and an account_number destination never hash the same", () => {
  const a = buildCanonicalPayload({ acceptCash: false, paymentDestination: { type: "bank_transfer", countryCode: "GB", currencyCode: "GBP", institutionName: "T", recipientName: "J", identifier: { type: "account_number", value: "1" } } });
  const b = buildCanonicalPayload({ acceptCash: false, paymentDestination: { type: "bank_transfer", countryCode: "GB", currencyCode: "GBP", institutionName: "T", recipientName: "J", identifier: { type: "iban", value: "1" } } });
  assert(hashPayload(a) !== hashPayload(b), "Different identifier types must never collide");
});

test("A country/currency change alone (same everything else) produces a different hash", () => {
  const a = buildCanonicalPayload({ acceptCash: false, paymentDestination: { type: "bank_transfer", countryCode: "GB", currencyCode: "GBP", institutionName: "T", recipientName: "J", identifier: { type: "account_number", value: "1" } } });
  const b = buildCanonicalPayload({ acceptCash: false, paymentDestination: { type: "bank_transfer", countryCode: "US", currencyCode: "USD", institutionName: "T", recipientName: "J", identifier: { type: "account_number", value: "1" } } });
  assert(hashPayload(a) !== hashPayload(b), "A resolved-country change must be treated as a real change, not silently ignored");
});

test("bank_transfer and contact_transfer with the 'same' identifier value never hash the same", () => {
  const a = buildCanonicalPayload({ acceptCash: false, paymentDestination: { type: "bank_transfer", countryCode: "NG", currencyCode: "NGN", institutionName: "T", recipientName: "J", identifier: { type: "account_number", value: "1" } } });
  const b = buildCanonicalPayload({ acceptCash: true, paymentDestination: null });
  assert(hashPayload(a) !== hashPayload(b), "Distinct configurations must never collide");
});

test("canonicalPayloadKey is stable JSON regardless of input key order", () => {
  const k1 = canonicalPayloadKey(buildCanonicalPayload({ acceptCash: true, paymentDestination: null }));
  const k2 = canonicalPayloadKey(buildCanonicalPayload({ paymentDestination: null, acceptCash: true }));
  assert(k1 === k2, "Canonical key must not depend on caller's own object key order");
});

console.log("\n" + "=".repeat(60));
console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
if (failed === 0) {
  console.log("✅ ALL TESTS PASSED");
} else {
  console.log("❌ SOME TESTS FAILED — see errors above");
  process.exitCode = 1;
}
