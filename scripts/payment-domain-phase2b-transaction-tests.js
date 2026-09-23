/**
 * Payment Domain — Batch 2B transaction/idempotency/versioning integration
 * tests.
 *
 * Exercises functions/src/vendors/setVendorPaymentInstructions.ts's exported
 * runSetVendorPaymentInstructionsCore() directly via the Admin SDK against
 * the Firestore emulator -- the same testing pattern this repo's existing
 * rules-test scripts already use (Admin SDK direct writes/reads), just
 * calling the real production transaction logic instead of hand-seeding
 * documents. This does NOT use or require the Functions emulator (blocked
 * by a documented, unrelated startup failure) -- runSetVendorPaymentInstructionsCore
 * has no dependency on https.onCall's request/auth/App-Check plumbing; that
 * wrapper is exercised only by the (still-blocked) callable-behavior path.
 *
 * Requires the Firestore emulator running first:
 *   firebase emulators:start --only firestore,auth --project demo-platform
 *
 * Build first: npm --prefix functions run build
 * Usage: node payment-domain-phase2b-transaction-tests.js
 */

const path = require("path");
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.GCLOUD_PROJECT = "demo-platform";

const admin = require("firebase-admin");
if (!admin.apps.length) {
  admin.initializeApp({ projectId: "demo-platform" });
}
const db = admin.firestore();

const { runSetVendorPaymentInstructionsCore } = require(
  path.join(__dirname, "..", "functions", "lib", "vendors", "setVendorPaymentInstructions")
);

let passed = 0, failed = 0, total = 0;

async function test(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.stack || e.message || e}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "Assertion failed");
}

async function assertRejects(promise, messageIncludes) {
  try {
    await promise;
  } catch (e) {
    if (messageIncludes && !String(e.message).includes(messageIncludes)) {
      throw new Error(`Expected error containing "${messageIncludes}", got: ${e.message}`);
    }
    return;
  }
  throw new Error("Expected a rejection, but none occurred");
}

const uniq = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const APP_CHECK = { present: false, verified: null };

async function seedCountry(countryCode, currencyCode) {
  await db.collection("countries").doc(countryCode).set({ countryCode, currencyCode });
}

async function seedVendor(overrides) {
  const vendorId = uniq("vendor");
  await db.collection("vendors").doc(vendorId).set({
    vendorId, name: "Test Vendor", verificationStatus: "approved", vendorStatus: "active",
    isVerified: true, isPublished: true, isDiscoverable: true,
    ...overrides,
  });
  return vendorId;
}

function callCore(vendorId, uid, data) {
  // Mirrors exactly what the https.onCall wrapper constructs after its own
  // authentication/role/App-Check checks -- this test plays the role of
  // that already-authorized caller, not a client.
  const context = { vendorId, uid, appCheck: APP_CHECK };
  return runSetVendorPaymentInstructionsCore(context, data, uniq("req"));
}

async function main() {
  console.log("🚀 PLATFORM — Payment Domain Batch 2B Transaction/Idempotency Integration Tests");
  console.log("=".repeat(60));

  await seedCountry("NG", "NGN");
  await seedCountry("GB", "GBP");
  await seedCountry("CA", "CAD");

  console.log("\n📋 Vendor existence");
  await test("A nonexistent vendor is rejected not-found, not described as merely missing a business location", async () => {
    const nonexistentVendorId = uniq("no-such-vendor");
    await assertRejects(
      callCore(nonexistentVendorId, "uid1", { idempotencyKey: uniq("k"), acceptCash: true, paymentDestination: null }),
      "Vendor profile not found"
    );
    const currentSnap = await db.collection("vendors").doc(nonexistentVendorId).collection("paymentInstructionsCurrent").doc("current").get();
    assert(!currentSnap.exists, "No current document should be created for a nonexistent vendor");
  });

  console.log("\n📋 Country/currency hard-fail");
  await test("Vendor with no resolvable country hard-fails failed-precondition, no NGN fallback", async () => {
    const vendorId = await seedVendor({}); // no countryCode/businessLocation/location at all
    await assertRejects(
      callCore(vendorId, "uid1", { idempotencyKey: uniq("k"), acceptCash: true, paymentDestination: null }),
      "Complete your business location"
    );
    const currentSnap = await db.collection("vendors").doc(vendorId).collection("paymentInstructionsCurrent").doc("current").get();
    assert(!currentSnap.exists, "No current document should be created for a hard-failed request");
  });

  console.log("\n📋 Configuration-state semantics");
  await test("null destination + acceptCash false is rejected (zero payment options)", async () => {
    const vendorId = await seedVendor({ countryCode: "NG" });
    await assertRejects(
      callCore(vendorId, "uid1", { idempotencyKey: uniq("k"), acceptCash: false, paymentDestination: null }),
      "at least one way to be paid"
    );
  });

  await test("Cash-only (null destination + acceptCash true) succeeds and derives currency", async () => {
    const vendorId = await seedVendor({ countryCode: "GB" });
    const res = await callCore(vendorId, "uid1", { idempotencyKey: uniq("k"), acceptCash: true, paymentDestination: null });
    assert(res.changed === true && res.version === 1, "First save should create version 1");
    const currentSnap = await db.collection("vendors").doc(vendorId).collection("paymentInstructionsCurrent").doc("current").get();
    assert(currentSnap.data().paymentDestination === null, "Cash-only current doc should have a null destination");
    assert(currentSnap.data().acceptCash === true, "Cash-only current doc should have acceptCash true");
  });

  console.log("\n📋 Bank Transfer (account_number) — versioning, immutability, idempotency");
  await test("First save creates version 1 with server-derived country/currency", async () => {
    const vendorId = await seedVendor({ countryCode: "NG" });
    const res = await callCore(vendorId, "uid1", {
      idempotencyKey: uniq("k"), acceptCash: false,
      paymentDestination: { type: "bank_transfer", institutionName: "Test Bank", recipientName: "Jane Vendor", identifier: { type: "account_number", value: "1234567890" } },
    });
    assert(res.changed === true && res.version === 1);
    const currentSnap = await db.collection("vendors").doc(vendorId).collection("paymentInstructionsCurrent").doc("current").get();
    const dest = currentSnap.data().paymentDestination;
    assert(dest.countryCode === "NG" && dest.currencyCode === "NGN", "countryCode/currencyCode must be server-derived, matching the vendor's real country");
  });

  await test("Same idempotency key + same payload: replay returns the cached result, no new version", async () => {
    const vendorId = await seedVendor({ countryCode: "NG" });
    const key = uniq("k");
    const payload = { idempotencyKey: key, acceptCash: false, paymentDestination: { type: "bank_transfer", institutionName: "Test Bank", recipientName: "Jane Vendor", identifier: { type: "account_number", value: "1234567890" } } };
    const first = await callCore(vendorId, "uid1", payload);
    const second = await callCore(vendorId, "uid1", payload);
    assert(first.recordId === second.recordId && first.version === second.version, "Replay must return the identical cached result");
    assert(second.changed === true, "The cached 'changed' flag from the original write should be returned");
  });

  await test("Same idempotency key + different payload: rejected", async () => {
    const vendorId = await seedVendor({ countryCode: "NG" });
    const key = uniq("k");
    await callCore(vendorId, "uid1", { idempotencyKey: key, acceptCash: false, paymentDestination: { type: "bank_transfer", institutionName: "Test Bank", recipientName: "Jane Vendor", identifier: { type: "account_number", value: "1111111111" } } });
    await assertRejects(
      callCore(vendorId, "uid1", { idempotencyKey: key, acceptCash: false, paymentDestination: { type: "bank_transfer", institutionName: "Test Bank", recipientName: "Jane Vendor", identifier: { type: "account_number", value: "2222222222" } } }),
      "already used"
    );
  });

  await test("New key + payload identical to current: zero-write no-op, no version bump", async () => {
    const vendorId = await seedVendor({ countryCode: "NG" });
    const destination = { type: "bank_transfer", institutionName: "Test Bank", recipientName: "Jane Vendor", identifier: { type: "account_number", value: "1234567890" } };
    const first = await callCore(vendorId, "uid1", { idempotencyKey: uniq("k"), acceptCash: false, paymentDestination: destination });
    const second = await callCore(vendorId, "uid1", { idempotencyKey: uniq("k"), acceptCash: false, paymentDestination: destination });
    assert(second.changed === false, "Identical configuration under a new key must be a no-op");
    assert(second.version === first.version, "Version must not bump on a no-op");
  });

  await test("A genuine change creates a new version and leaves history immutable", async () => {
    const vendorId = await seedVendor({ countryCode: "NG" });
    const first = await callCore(vendorId, "uid1", { idempotencyKey: uniq("k"), acceptCash: false, paymentDestination: { type: "bank_transfer", institutionName: "Test Bank", recipientName: "Jane Vendor", identifier: { type: "account_number", value: "1111111111" } } });
    const second = await callCore(vendorId, "uid1", { idempotencyKey: uniq("k"), acceptCash: false, paymentDestination: { type: "bank_transfer", institutionName: "Test Bank", recipientName: "Jane Vendor", identifier: { type: "account_number", value: "2222222222" } } });
    assert(second.version === first.version + 1, "A real change must bump the version");

    const originalSnap = await db.collection("vendors").doc(vendorId).collection("paymentInstructions").doc(first.recordId).get();
    assert(originalSnap.data().paymentDestination.identifier.value === "1111111111", "Original historical record must remain byte-identical after a later change");
    assert(originalSnap.data().version === 1, "Original historical record's version must remain unchanged");
  });

  console.log("\n📋 IBAN identifier");
  await test("IBAN destination saves normalized (uppercase, no spaces)", async () => {
    const vendorId = await seedVendor({ countryCode: "GB" });
    const res = await callCore(vendorId, "uid1", {
      idempotencyKey: uniq("k"), acceptCash: false,
      paymentDestination: { type: "bank_transfer", institutionName: "NatWest", recipientName: "Jane Vendor", identifier: { type: "iban", value: "gb29 nwbk 6016 1331 9268 19", swiftBic: "nwbkgb2l" } },
    });
    const recordSnap = await db.collection("vendors").doc(vendorId).collection("paymentInstructions").doc(res.recordId).get();
    const identifier = recordSnap.data().paymentDestination.identifier;
    assert(identifier.value === "GB29NWBK60161331926819", "IBAN should be stored normalized");
    assert(identifier.swiftBic === "NWBKGB2L", "swiftBic should be stored normalized");
  });

  await test("Switching from account_number to IBAN creates a new version (never conflated)", async () => {
    const vendorId = await seedVendor({ countryCode: "GB" });
    const first = await callCore(vendorId, "uid1", { idempotencyKey: uniq("k"), acceptCash: false, paymentDestination: { type: "bank_transfer", institutionName: "NatWest", recipientName: "Jane Vendor", identifier: { type: "account_number", value: "12345678" } } });
    const second = await callCore(vendorId, "uid1", { idempotencyKey: uniq("k"), acceptCash: false, paymentDestination: { type: "bank_transfer", institutionName: "NatWest", recipientName: "Jane Vendor", identifier: { type: "iban", value: "GB29NWBK60161331926819" } } });
    assert(second.version === first.version + 1, "An identifier-type change must be treated as a real change");
  });

  console.log("\n📋 Contact Transfer (email / phone)");
  await test("Contact Transfer + email saves with no institutionName field stored", async () => {
    const vendorId = await seedVendor({ countryCode: "CA" });
    const res = await callCore(vendorId, "uid1", {
      idempotencyKey: uniq("k"), acceptCash: false,
      paymentDestination: { type: "contact_transfer", recipientName: "Jane Vendor", identifier: { type: "email", value: "Jane@Example.com" } },
    });
    const recordSnap = await db.collection("vendors").doc(vendorId).collection("paymentInstructions").doc(res.recordId).get();
    const dest = recordSnap.data().paymentDestination;
    assert(dest.identifier.value === "jane@example.com", "Email should be stored lowercase-normalized");
    assert(!("institutionName" in dest), "contact_transfer must never store institutionName");
    assert(dest.countryCode === "CA" && dest.currencyCode === "CAD", "countryCode/currencyCode must still be server-derived for contact_transfer");
  });

  await test("Contact Transfer + phone normalizes to E.164 using the vendor's resolved country", async () => {
    const vendorId = await seedVendor({ countryCode: "CA" });
    const res = await callCore(vendorId, "uid1", {
      idempotencyKey: uniq("k"), acceptCash: true,
      paymentDestination: { type: "contact_transfer", recipientName: "Jane Vendor", identifier: { type: "phone", value: "4165551234" } },
    });
    const recordSnap = await db.collection("vendors").doc(vendorId).collection("paymentInstructions").doc(res.recordId).get();
    assert(recordSnap.data().paymentDestination.identifier.value.startsWith("+1"), "Phone should normalize to E.164 via the vendor's own country");
  });

  console.log("\n📋 Privacy: change events and audit logs never carry raw sensitive values");
  await test("Change event carries only masked identifiers, never raw account number/IBAN/email/phone/routing/swiftBic", async () => {
    const vendorId = await seedVendor({ countryCode: "GB" });
    await callCore(vendorId, "uid1", {
      idempotencyKey: uniq("k"), acceptCash: false,
      paymentDestination: { type: "bank_transfer", institutionName: "NatWest", recipientName: "Jane Vendor", identifier: { type: "iban", value: "GB29NWBK60161331926819", swiftBic: "NWBKGB2L" } },
    });
    const eventsSnap = await db.collection("paymentInstructionChangeEvents").where("vendorId", "==", vendorId).get();
    assert(eventsSnap.size === 1, "Exactly one change event should exist");
    const event = eventsSnap.docs[0].data();
    const raw = JSON.stringify(event);
    assert(!raw.includes("GB29NWBK60161331926819"), "Raw IBAN must never appear in a change event");
    assert(!raw.includes("NWBKGB2L"), "Raw SWIFT/BIC must never appear in a change event");
    assert(typeof event.maskedIdentifierNew === "string" && event.maskedIdentifierNew.includes("•"), "maskedIdentifierNew should be present and masked");
    assert(!("accountNumberMaskedNew" in event) && !("accountNumberMaskedOld" in event), "Change event field names must be identifier-neutral, not accountNumberMasked*");
  });

  await test("Generic audit log never carries a raw identifier or destination contents", async () => {
    const vendorId = await seedVendor({ countryCode: "NG" });
    await callCore(vendorId, "uid1", {
      idempotencyKey: uniq("k"), acceptCash: false,
      paymentDestination: { type: "bank_transfer", institutionName: "Test Bank", recipientName: "Jane Vendor", identifier: { type: "account_number", value: "5555555555" } },
    });
    const logsSnap = await db.collection("auditLogs").where("eventType", "==", "vendor.payment_instructions_set").where("target.id", "==", vendorId).get();
    assert(logsSnap.size >= 1, "An audit log entry should exist");
    const raw = JSON.stringify(logsSnap.docs[logsSnap.size - 1].data());
    assert(!raw.includes("5555555555"), "Raw account number must never appear in the generic audit log");
    assert(!raw.includes("Test Bank"), "Institution name must never appear in the generic audit log");
  });

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("✅ ALL TESTS PASSED");
  } else {
    console.log("❌ SOME TESTS FAILED — see errors above");
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
