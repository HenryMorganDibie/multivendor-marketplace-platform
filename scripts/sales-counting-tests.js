/**
 * Sales counting, to the client's definition:
 *   - counts only on Completed, never on request or accept
 *   - counts quantity, not order count
 *   - counts whether or not inventory tracking is on
 *   - external (vendor-recorded) orders never count
 *   - a repeated transition cannot increment twice
 */
process.env.GCLOUD_PROJECT = "demo-platform";
process.env.GOOGLE_CLOUD_PROJECT = "demo-platform";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: "demo-platform" });
const fdb = admin.firestore();

let pass = 0, fail = 0;
const check = (n, label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${n}. ${label}`); }
  else { fail++; console.log(`FAIL  ${n}. ${label}${detail ? `  (${detail})` : ""}`); }
};

const VENDOR = `sales_test_vendor_${Date.now()}`;

async function makeItem(name, trackInventory) {
  const ref = fdb.collection("vendors").doc(VENDOR).collection("catalogItems").doc();
  await ref.set({
    itemId: ref.id, vendorId: VENDOR, name, basePrice: 1000, orderCount: 0,
    trackInventory, inventoryQuantity: trackInventory ? 50 : 0, reservedQuantity: 0,
    isOutOfStock: false, moderationStatus: "approved",
  });
  return ref;
}
const countOf = async (ref) => (await ref.get()).data().orderCount ?? 0;

(async () => {
  // Load the compiled helper the functions actually use.
  const { adjustInventoryAfterOrder } = require("../functions/lib/inventory/inventoryUtils");

  const tracked = await makeItem("Tracked item", true);
  const untracked = await makeItem("Untracked item", false);

  // 1 + 2: a completed internal sale counts quantity, tracking on or off.
  await adjustInventoryAfterOrder(VENDOR, [{ itemId: tracked.id, quantity: 3 }], true);
  await adjustInventoryAfterOrder(VENDOR, [{ itemId: untracked.id, quantity: 4 }], true);
  check(1, "Completed sale counts quantity when inventory tracking is ON", await countOf(tracked) === 3, `got ${await countOf(tracked)}`);
  check(2, "Completed sale counts quantity when inventory tracking is OFF", await countOf(untracked) === 4, `got ${await countOf(untracked)}`);

  // 3: stock only moves for the tracked item.
  const t = (await tracked.get()).data();
  const u = (await untracked.get()).data();
  check(3, "Stock decrements only for the item that tracks it",
    t.inventoryQuantity === 47 && u.inventoryQuantity === 0,
    `tracked=${t.inventoryQuantity} untracked=${u.inventoryQuantity}`);

  // 4: an external order moves stock but is not a sale.
  const beforeExternal = await countOf(tracked);
  await adjustInventoryAfterOrder(VENDOR, [{ itemId: tracked.id, quantity: 5 }], false);
  const afterExternal = await countOf(tracked);
  check(4, "External (vendor-recorded) order does NOT count as a sale",
    afterExternal === beforeExternal, `${beforeExternal} -> ${afterExternal}`);
  check(5, "External order still decrements stock",
    (await tracked.get()).data().inventoryQuantity === 42,
    `got ${(await tracked.get()).data().inventoryQuantity}`);

  // 6: quantity, not order count. One order of 10 is ten sales, not one.
  const fresh = await makeItem("Quantity check", false);
  await adjustInventoryAfterOrder(VENDOR, [{ itemId: fresh.id, quantity: 10 }], true);
  check(6, "Counts item quantity rather than number of orders", await countOf(fresh) === 10, `got ${await countOf(fresh)}`);

  console.log(`\n${fail === 0 ? "ALL SALES COUNTING TESTS PASSED" : `${fail} FAILURE(S)`}  (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
