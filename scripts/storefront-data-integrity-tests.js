/**
 * PLATFORM — Storefront Data Integrity Patch acceptance tests.
 *
 * Focused coverage for the patch that made vendors/{vendorId}.weeklyHours
 * and .fulfillmentTypes authoritative (updateVendorSettings.ts), enforced
 * fulfillmentTypes server-side at checkout (repriceCart.ts), and closed the
 * unsafe-scheme / wrong-platform gap in contactLinks (updateVendorStorefront.ts).
 *
 * Invokes the compiled callable handlers' `.run(request)` directly (a plain
 * async function call, not the HTTPS callable wire protocol) against a real
 * Firestore emulator, rather than going through `firebase emulators:start
 * --only functions`. In this environment the Functions emulator crashes
 * during startup while registering the pre-existing onVendorWrite Firestore
 * trigger ("Error adding firestore function: ... Unable to parse JSON") --
 * reproduced identically with onVendorWrite excluded from --only and with
 * no code from this patch involved at all, so it is a pre-existing
 * emulator/tooling issue in this sandbox, not something this patch caused
 * or can fix. Calling .run() directly against the real Firestore emulator
 * still exercises the actual validation, persistence and enforcement logic
 * end to end; it only skips the HTTPS transport layer, which none of this
 * patch's code touches.
 *
 * Run:  node storefront-data-integrity-tests.js
 * Requires: firebase emulators:start --only firestore --project demo-platform
 * Requires: functions/lib to be built (npm run build in functions/)
 */
process.env.GCLOUD_PROJECT = "demo-platform";
process.env.GOOGLE_CLOUD_PROJECT = "demo-platform";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: "demo-platform" });
const fdb = admin.firestore();

const { updateVendorSettings } = require("../functions/lib/vendors/updateVendorSettings");
const { updateVendorStorefront } = require("../functions/lib/vendors/updateVendorStorefront");
const { repriceCart } = require("../functions/lib/orders/repriceCart");

let pass = 0, fail = 0;
const check = (n, label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${n}. ${label}`); }
  else { fail++; console.log(`FAIL  ${n}. ${label}${detail !== undefined ? `  (${detail})` : ""}`); }
};
async function expectError(promise, codeSubstring) {
  try {
    await promise;
    return { threw: false };
  } catch (e) {
    return { threw: true, code: e.code, message: e.message, matches: String(e.code).includes(codeSubstring) };
  }
}

function vendorRequest(vendorId, uid, data) {
  return { auth: { uid, token: { role: "vendor", vendorId } }, data, rawRequest: {} };
}
function customerRequest(uid, data) {
  return { auth: { uid, token: { role: "customer" } }, data, rawRequest: {} };
}

let counter = 0;
function uid(prefix) { return `${prefix}_${Date.now()}_${counter++}`; }

async function seedCountryAvailability() {
  await fdb.collection("countryAvailability").doc("NG").set({
    countryCode: "NG", countryName: "Nigeria", status: "ACTIVE",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: "sdip_test_seed",
  });
}

async function seedVendor(id) {
  await fdb.collection("vendors").doc(id).set({
    vendorId: id,
    businessName: `SDIP Test Vendor ${id}`,
    username: id,
    countryCode: "NG",
    isDiscoverable: true,
    isPublished: true,
    verificationStatus: "approved",
    vendorStatus: "active",
  });
}

async function seedCatalogItem(vendorId, itemId, overrides = {}) {
  await fdb.collection("vendors").doc(vendorId).collection("catalogItems").doc(itemId).set({
    itemId,
    vendorId,
    name: "Test Plate",
    basePrice: 1500,
    currency: "NGN",
    photos: [],
    isAvailable: true,
    isHidden: false,
    isOutOfStock: false,
    inventoryQuantity: 100,
    reservedQuantity: 0,
    trackInventory: false,
    orderCount: 0,
    moderationStatus: "approved",
    ...overrides,
  });
}

async function main() {
  console.log("🚀 PLATFORM — Storefront Data Integrity Patch acceptance tests");
  console.log("=".repeat(60));

  await seedCountryAvailability();
  const vendorAId = uid("sdip_vendor_a");
  const vendorAUid = uid("sdip_vendor_a_uid");
  await seedVendor(vendorAId);
  const itemId = uid("sdip_item");
  await seedCatalogItem(vendorAId, itemId);
  const customerUid = uid("sdip_customer");

  // ── SECTION 1 — Business Hours (updateVendorSettings weeklyHours) ───────
  console.log("\n📋 Section 1: Business Hours");

  {
    const validHours = {
      Monday: { closed: false, ranges: [{ open: "9:00 AM", close: "5:00 PM" }] },
      Tuesday: { closed: false, ranges: [{ open: "9:00 AM", close: "5:00 PM" }] },
      Sunday: { closed: true, ranges: [] },
    };
    const r = await updateVendorSettings.run(vendorRequest(vendorAId, vendorAUid, { weeklyHours: validHours }));
    check(1, "Valid weeklyHours persists", r.success === true);

    const snap = await fdb.collection("vendors").doc(vendorAId).get();
    const saved = snap.data().weeklyHours;
    check(2, "Saved weeklyHours round-trips Monday's ranges exactly",
      saved.Monday.ranges.length === 1 && saved.Monday.ranges[0].open === "9:00 AM" && saved.Monday.ranges[0].close === "5:00 PM",
      JSON.stringify(saved.Monday));
    check(3, "Closed day survives with closed:true and empty ranges",
      saved.Sunday.closed === true && Array.isArray(saved.Sunday.ranges) && saved.Sunday.ranges.length === 0);
  }

  {
    const multiRange = {
      Wednesday: { closed: false, ranges: [
        { open: "9:00 AM", close: "12:00 PM" },
        { open: "2:00 PM", close: "6:00 PM" },
      ] },
    };
    await updateVendorSettings.run(vendorRequest(vendorAId, vendorAUid, { weeklyHours: multiRange }));
    const snap = await fdb.collection("vendors").doc(vendorAId).get();
    const wed = snap.data().weeklyHours.Wednesday;
    check(4, "Multiple ranges on one day round-trip in order",
      wed.ranges.length === 2 && wed.ranges[0].open === "9:00 AM" && wed.ranges[1].open === "2:00 PM",
      JSON.stringify(wed));

    const mon = snap.data().weeklyHours.Monday;
    check(5, "A partial weeklyHours save does not wipe previously-saved days",
      mon && mon.ranges.length === 1 && mon.ranges[0].open === "9:00 AM", JSON.stringify(mon));
  }

  {
    const r1 = await expectError(
      updateVendorSettings.run(vendorRequest(vendorAId, vendorAUid, { weeklyHours: { Monday: { closed: false, ranges: [{ open: "25:00 AM", close: "5:00 PM" }] } } })),
      "invalid-argument"
    );
    check(6, "Malformed time string is rejected", r1.threw && r1.matches, r1.message);

    const r2 = await expectError(
      updateVendorSettings.run(vendorRequest(vendorAId, vendorAUid, { weeklyHours: { Notaday: { closed: true, ranges: [] } } })),
      "invalid-argument"
    );
    check(7, "Unknown weekday key is rejected", r2.threw && r2.matches, r2.message);

    const r3 = await expectError(
      updateVendorSettings.run(vendorRequest(vendorAId, vendorAUid, { weeklyHours: { Monday: { closed: "no", ranges: [] } } })),
      "invalid-argument"
    );
    check(8, "Non-boolean closed value is rejected", r3.threw && r3.matches, r3.message);

    const before = (await fdb.collection("vendors").doc(vendorAId).get()).data().weeklyHours;
    const sixRanges = Array.from({ length: 6 }, () => ({ open: "9:00 AM", close: "5:00 PM" }));
    const r4 = await expectError(
      updateVendorSettings.run(vendorRequest(vendorAId, vendorAUid, { weeklyHours: { Monday: { closed: false, ranges: sixRanges } } })),
      "invalid-argument"
    );
    const after = (await fdb.collection("vendors").doc(vendorAId).get()).data().weeklyHours;
    check(9, "Exceeding max ranges-per-day is rejected and leaves the doc unchanged",
      r4.threw && r4.matches && JSON.stringify(before.Monday) === JSON.stringify(after.Monday), r4.message);
  }

  // ── SECTION 2 — Fulfillment (updateVendorSettings fulfillmentTypes) ─────
  console.log("\n📋 Section 2: Fulfillment Methods");

  {
    const r = await updateVendorSettings.run(vendorRequest(vendorAId, vendorAUid, { fulfillmentTypes: ["pickup", "delivery"] }));
    check(10, "Valid fulfillmentTypes persists", r.success === true);
    const saved = (await fdb.collection("vendors").doc(vendorAId).get()).data().fulfillmentTypes;
    check(11, "Saved fulfillmentTypes matches exactly what was enabled", JSON.stringify(saved) === JSON.stringify(["pickup", "delivery"]), JSON.stringify(saved));
  }

  {
    const r1 = await expectError(updateVendorSettings.run(vendorRequest(vendorAId, vendorAUid, { fulfillmentTypes: ["teleport"] })), "invalid-argument");
    check(12, "Unknown fulfillment value is rejected", r1.threw && r1.matches, r1.message);

    const r2 = await expectError(updateVendorSettings.run(vendorRequest(vendorAId, vendorAUid, { fulfillmentTypes: ["pickup", "pickup"] })), "invalid-argument");
    check(13, "Duplicate fulfillment value is rejected", r2.threw && r2.matches, r2.message);

    const r3 = await expectError(updateVendorSettings.run(vendorRequest(vendorAId, vendorAUid, { fulfillmentTypes: [] })), "invalid-argument");
    check(14, "Empty fulfillmentTypes array is rejected (at least one method required)", r3.threw && r3.matches, r3.message);
  }

  // ── SECTION 3 — Checkout enforcement (repriceCart) ───────────────────────
  console.log("\n📋 Section 3: Checkout fulfillment enforcement");

  await updateVendorSettings.run(vendorRequest(vendorAId, vendorAUid, { fulfillmentTypes: ["pickup"] }));

  {
    const r = await repriceCart.run(customerRequest(customerUid, { vendorId: vendorAId, fulfillmentType: "pickup", items: [{ itemId, quantity: 1 }] }));
    check(15, "Checkout accepts a method the vendor has enabled", r.success === true);
  }
  {
    const r = await expectError(
      repriceCart.run(customerRequest(customerUid, { vendorId: vendorAId, fulfillmentType: "shipping", items: [{ itemId, quantity: 1 }] })),
      "failed-precondition"
    );
    check(16, "Checkout rejects a method the vendor has NOT enabled", r.threw && r.matches, r.message);
  }
  {
    // A vendor who has never configured fulfillmentTypes (empty/missing) --
    // every pre-existing vendor before this patch -- must not be locked out
    // of checkout entirely. This is the approved compatibility behavior.
    const vendorBId = uid("sdip_vendor_b");
    await seedVendor(vendorBId);
    const itemB = uid("sdip_item_b");
    await seedCatalogItem(vendorBId, itemB);
    const r = await repriceCart.run(customerRequest(customerUid, { vendorId: vendorBId, fulfillmentType: "shipping", items: [{ itemId: itemB, quantity: 1 }] }));
    check(17, "A vendor with no fulfillmentTypes configured yet does not block any method (legacy compatibility)", r.success === true);
  }
  {
    // A malicious/hand-crafted direct callable request naming a value outside
    // the vendor's enabled set must still be rejected server-side, regardless
    // of what any client UI would have allowed the user to select.
    const r = await expectError(
      repriceCart.run(customerRequest(customerUid, { vendorId: vendorAId, fulfillmentType: "delivery", items: [{ itemId, quantity: 1 }] })),
      "failed-precondition"
    );
    check(18, "A hand-crafted request for a disabled method cannot bypass server enforcement", r.threw && r.matches, r.message);
  }

  // ── SECTION 4 — External link security (updateVendorStorefront) ─────────
  console.log("\n📋 Section 4: External link security");

  {
    const r = await updateVendorStorefront.run(vendorRequest(vendorAId, vendorAUid, { contactLinks: { website: "https://example.com/menu" } }));
    check(19, "Existing valid HTTPS website URL is preserved", r.success === true);
    const saved = (await fdb.collection("vendors").doc(vendorAId).get()).data().contactLinks.website;
    check(20, "Preserved website URL still resolves to the same https link", saved === "https://example.com/menu", saved);
  }
  {
    await updateVendorStorefront.run(vendorRequest(vendorAId, vendorAUid, { contactLinks: { website: "yourwebsite.com" } }));
    const saved = (await fdb.collection("vendors").doc(vendorAId).get()).data().contactLinks.website;
    check(21, "Bare domain website normalizes to https://", saved.startsWith("https://yourwebsite.com"), saved);
  }
  {
    await updateVendorStorefront.run(vendorRequest(vendorAId, vendorAUid, { contactLinks: { instagram: "@my.handle" } }));
    const saved = (await fdb.collection("vendors").doc(vendorAId).get()).data().contactLinks.instagram;
    check(22, "@handle Instagram normalizes to a real instagram.com link", saved === "https://instagram.com/my.handle", saved);
  }
  {
    await updateVendorStorefront.run(vendorRequest(vendorAId, vendorAUid, { contactLinks: { tiktok: "https://www.tiktok.com/@myshop" } }));
    const saved = (await fdb.collection("vendors").doc(vendorAId).get()).data().contactLinks.tiktok;
    check(23, "Existing www.tiktok.com form is recognized and preserved", saved.includes("tiktok.com/@myshop"), saved);
  }
  {
    const r = await expectError(updateVendorStorefront.run(vendorRequest(vendorAId, vendorAUid, { contactLinks: { website: "javascript:alert(1)" } })), "invalid-argument");
    check(24, "javascript: scheme is rejected", r.threw && r.matches, r.message);
  }
  {
    const r = await expectError(updateVendorStorefront.run(vendorRequest(vendorAId, vendorAUid, { contactLinks: { website: "file:///etc/passwd" } })), "invalid-argument");
    check(25, "file: scheme is rejected", r.threw && r.matches, r.message);
  }
  {
    const r = await expectError(updateVendorStorefront.run(vendorRequest(vendorAId, vendorAUid, { contactLinks: { instagram: "https://evil.example.com/@my.handle" } })), "invalid-argument");
    check(26, "Instagram link on an unrelated host is rejected", r.threw && r.matches, r.message);
  }
  {
    const r = await expectError(updateVendorStorefront.run(vendorRequest(vendorAId, vendorAUid, { contactLinks: { tiktok: "https://tiktok.com.evil.com/@x" } })), "invalid-argument");
    check(27, "Lookalike host (tiktok.com.evil.com) is rejected for TikTok", r.threw && r.matches, r.message);
  }

  // ── SECTION 5 — Regression: unrelated behavior unchanged ─────────────────
  console.log("\n📋 Section 5: Regression checks");

  {
    // minimumOrderAmount enforcement at checkout, unrelated to this patch,
    // must still behave exactly as before.
    await fdb.collection("vendors").doc(vendorAId).update({ minimumOrderAmount: 5000 });
    const r = await expectError(
      repriceCart.run(customerRequest(customerUid, { vendorId: vendorAId, fulfillmentType: "pickup", items: [{ itemId, quantity: 1 }] })),
      "failed-precondition"
    );
    check(28, "Existing minimum-order-amount enforcement is unchanged", r.threw && r.matches, r.message);
    await fdb.collection("vendors").doc(vendorAId).update({ minimumOrderAmount: 0 });
  }
  {
    // Basic-plan gating on minimumOrderAmount/policy (untouched code path)
    // must remain exactly as it was before this patch. No vendorSubscriptions
    // doc exists for this vendor, so resolveEffectivePlan falls back to Basic.
    const r = await expectError(updateVendorSettings.run(vendorRequest(vendorAId, vendorAUid, { policy: "No refunds" })), "permission-denied");
    check(29, "Basic-plan gate on policy is unchanged (still permission-denied)", r.threw && r.matches, r.message);
  }
  {
    // weeklyHours/fulfillmentTypes must remain usable on the basic plan
    // (they are not premium features) even though policy/minimumOrderAmount
    // are gated on the very same callable.
    const r = await updateVendorSettings.run(vendorRequest(vendorAId, vendorAUid, { fulfillmentTypes: ["pickup", "delivery"] }));
    check(30, "weeklyHours/fulfillmentTypes remain available on the basic plan", r.success === true);
  }
  {
    // A non-vendor caller must still be rejected exactly as before.
    const r = await expectError(updateVendorSettings.run({ auth: { uid: customerUid, token: { role: "customer" } }, data: { fulfillmentTypes: ["pickup"] }, rawRequest: {} }), "permission-denied");
    check(31, "Non-vendor caller is still rejected by updateVendorSettings", r.threw && r.matches, r.message);
  }

  // ── SECTION 6 — Regression: "internal" crash fixes (device bug report) ──
  console.log("\n📋 Section 6: internal-error crash fixes");

  {
    // A vendor-role token with no vendorId claim (stale/unrepaired claims)
    // previously threw a raw, non-HttpsError Firestore SDK exception --
    // "internal" on the client with no actionable detail. Must now surface
    // a clear, typed failed-precondition instead.
    const r = await expectError(
      updateVendorSettings.run({ auth: { uid: uid("no_vendorid"), token: { role: "vendor" } }, data: { weeklyHours: { Monday: { closed: false, ranges: [{ open: "9:00 AM", close: "6:00 PM" }] } } }, rawRequest: {} }),
      "failed-precondition"
    );
    check(32, "Missing vendorId claim now fails with a clear, actionable error instead of opaque internal", r.threw && r.matches, r.message);
  }
  {
    // A "cancelled" vendorSubscriptions doc with no currentPeriodEnd
    // previously crashed resolveEffectivePlan with a raw TypeError
    // ("in" operator on undefined) -- also surfaced to the client as
    // opaque "internal". Must no longer throw at all for a Business
    // Hours / Fulfillment save (neither field is plan-gated).
    const vendorCId = uid("sdip_vendor_c");
    const vendorCUid = uid("sdip_vendor_c_uid");
    await seedVendor(vendorCId);
    await fdb.collection("vendorSubscriptions").doc(vendorCId).set({ plan: "standard", status: "cancelled" });
    const r = await updateVendorSettings.run(vendorRequest(vendorCId, vendorCUid, { weeklyHours: { Tuesday: { closed: false, ranges: [{ open: "10:00 AM", close: "4:00 PM" }] } } }));
    check(33, "A cancelled subscription with no currentPeriodEnd no longer crashes updateVendorSettings", r.success === true);
  }

  // ── SECTION 7 — Real persistence with the exact requested schedule ──────
  console.log("\n📋 Section 7: Real persistence (exact requested schedule)");

  {
    const requestedSchedule = {
      Sunday: { closed: true, ranges: [] },
      Monday: { closed: false, ranges: [{ open: "9:00 AM", close: "6:00 PM" }] },
      Tuesday: { closed: false, ranges: [{ open: "10:00 AM", close: "7:00 PM" }] },
      Wednesday: { closed: false, ranges: [{ open: "9:00 AM", close: "6:00 PM" }] },
      Thursday: { closed: false, ranges: [{ open: "9:00 AM", close: "6:00 PM" }] },
      Friday: { closed: false, ranges: [{ open: "9:00 AM", close: "9:00 PM" }] },
      Saturday: { closed: false, ranges: [{ open: "10:00 AM", close: "4:00 PM" }] },
    };
    const r = await updateVendorSettings.run(vendorRequest(vendorAId, vendorAUid, { weeklyHours: requestedSchedule }));
    check(34, "Exact requested schedule saves successfully", r.success === true);

    const saved = (await fdb.collection("vendors").doc(vendorAId).get()).data().weeklyHours;
    check(35, "Firestore weeklyHours matches the exact requested schedule byte-for-byte", JSON.stringify(saved) === JSON.stringify(requestedSchedule), JSON.stringify(saved));

    // "Leave and reopen" -- business-hours.tsx seeds its draft from
    // vendor.weeklyHours on mount, and mapVendorDoc.ts maps this same field
    // straight through with no transformation, so re-reading the document
    // fresh (simulating a cold re-entry into the screen) is the exact same
    // authoritative round trip a real reload performs.
    const reread = (await fdb.collection("vendors").doc(vendorAId).get()).data().weeklyHours;
    check(36, "Reload (fresh document read) hydrates to exactly the persisted schedule", JSON.stringify(reread) === JSON.stringify(requestedSchedule), JSON.stringify(reread));
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${pass}/${pass + fail} passed, ${fail} failed`);
  if (fail === 0) console.log("✅ ALL TESTS PASSED");
  else console.log("❌ SOME TESTS FAILED — see above");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
