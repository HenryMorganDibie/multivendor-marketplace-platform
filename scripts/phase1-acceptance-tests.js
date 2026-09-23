/**
 * Phase 1 acceptance tests — vendor registration and progressive onboarding.
 * Maps 1:1 to the 11 acceptance requirements in the Frontend Implementation doc.
 */
const PROJECT_ID = "demo-platform";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const { initializeApp, getApps } = require("firebase/app");
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword } = require("firebase/auth");
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require("firebase/functions");
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });

const app = getApps().find((a) => a.name === "p1") || initializeApp({ apiKey: "demo", projectId: PROJECT_ID }, "p1");
const auth = getAuth(app), fns = getFunctions(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
connectFunctionsEmulator(fns, "127.0.0.1", 5001);

let pass = 0, fail = 0;
function check(n, label, ok, detail) {
  if (ok) { console.log(`PASS  ${n}. ${label}`); pass++; }
  else { console.error(`FAIL  ${n}. ${label}\n      ${JSON.stringify(detail)}`); fail++; }
}

async function main() {
  const email = `phase1.vendor.${Date.now()}@platform.test`;
  const cred = await createUserWithEmailAndPassword(auth, email, "DemoPass123!");
  const uid = cred.user.uid;
  await cred.user.getIdToken(true);

  // The onUserCreate auth trigger creates users/{uid}. It's asynchronous, so
  // wait for it rather than racing it — this is a test-harness concern, not a
  // production one (a real signup screen has a human's reaction time in between).
  for (let i = 0; i < 30; i++) {
    if ((await admin.firestore().collection("users").doc(uid).get()).exists) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  // ── 1. Register with NO business name and NO custom username ────────────
  const completeRegistration = httpsCallable(fns, "completeRegistration");
  let regResult;
  try {
    regResult = await completeRegistration({
      role: "vendor",
      firstName: "Ada", lastName: "Obi",
      phoneNumber: "+2348012345678",
      country: "Nigeria",
    });
    check(1, "Vendor registers without business name or custom username", regResult.data.success === true, regResult.data);
  } catch (err) {
    check(1, "Vendor registers without business name or custom username", false, err.message);
    console.log("\nCannot continue without a vendor. Aborting.");
    process.exit(1);
  }

  const vendorId = regResult.data.vendorId;
  const vendorSnap = await admin.firestore().collection("vendors").doc(vendorId).get();
  const v = vendorSnap.data();

  // ── 2. Temporary username auto-generated ────────────────────────────────
  check(2, "Temporary username auto-generated",
    typeof v.username === "string" && /^platform_[a-z0-9]{6}$/.test(v.username) && v.isSystemGeneratedUsername === true,
    { username: v.username, isSystemGenerated: v.isSystemGeneratedUsername });

  // ── 3. Basic plan + vendor role assigned ────────────────────────────────
  const userSnap = await admin.firestore().collection("users").doc(uid).get();
  check(3, "Basic plan and vendor role assigned",
    v.plan === "basic" && userSnap.data().role === "vendor",
    { plan: v.plan, role: userSnap.data().role });

  // ── 4. Country and currency assigned correctly ──────────────────────────
  check(4, "Country resolved to ISO code",
    v.countryCode === "NG",
    { country: v.country, countryCode: v.countryCode });

  // ── 5. Vendor reaches dashboard (onboarding status resolvable) ──────────
  await cred.user.getIdToken(true); // pick up new vendor claims
  const getStatus = httpsCallable(fns, "getVendorOnboardingStatus");
  const status = (await getStatus({})).data;
  check(5, "Onboarding checklist resolves for a brand-new vendor",
    status.success === true && Array.isArray(status.steps) && status.steps.length > 0,
    { steps: status.steps?.length });

  // ── 6/7. Missing requirements block ONLY publication; payment doesn't ────
  const setPublish = httpsCallable(fns, "setVendorPublishStatus");
  let blockedErr = null;
  try {
    await setPublish({ isPublished: true });
  } catch (err) { blockedErr = err; }
  check(6, "Incomplete vendor is blocked from publishing (not from registering)",
    blockedErr !== null && /business name|category|product/i.test(blockedErr.message),
    blockedErr?.message);

  const paymentStep = status.steps.find((s) => s.id === "payment_method");
  check(7, "Missing payment method does NOT block publication",
    paymentStep && paymentStep.complete === false && paymentStep.blocksPublication === false,
    paymentStep);

  // Now complete the publication requirements.
  await admin.firestore().collection("vendors").doc(vendorId).update({
    businessName: "Ada's Kitchen", name: "Ada's Kitchen",
    categoryId: "food_drinks", categoryName: "Food & Drinks",
  });
  const itemRef = admin.firestore().collection("vendors").doc(vendorId).collection("catalogItems").doc();
  await itemRef.set({
    itemId: itemRef.id, vendorId, name: "Jollof Rice", basePrice: 2500,
    isAvailable: true, isHidden: false, moderationStatus: "pending",
    trackInventory: false, orderCount: 0, currency: "NGN",
  });

  // ── 8 (part a). Pending item does NOT satisfy the catalog requirement ────
  let stillBlocked = null;
  try { await setPublish({ isPublished: true }); } catch (err) { stillBlocked = err; }
  check(8, "Item under moderation review does not count toward publishing",
    stillBlocked !== null && /product|review/i.test(stillBlocked.message),
    stillBlocked?.message);

  await itemRef.update({ moderationStatus: "approved" });

  // ── 9. Unverified vendor CAN publish and is NOT discoverable ────────────
  const publishRes = await setPublish({ isPublished: true });
  const afterPublish = (await admin.firestore().collection("vendors").doc(vendorId).get()).data();
  check(9, "Unverified vendor can publish once requirements are met",
    publishRes.data.isPublished === true && afterPublish.isPublished === true && afterPublish.verificationStatus !== "approved",
    { isPublished: afterPublish.isPublished, verificationStatus: afterPublish.verificationStatus });

  check(10, "Unverified vendor is excluded from discovery",
    afterPublish.isDiscoverable === false,
    { isDiscoverable: afterPublish.isDiscoverable });

  // ── 11. Duplicate account rejected ──────────────────────────────────────
  let dupErr = null;
  try { await createUserWithEmailAndPassword(auth, email, "DemoPass123!"); }
  catch (err) { dupErr = err; }
  check(11, "Duplicate account is rejected",
    dupErr !== null && /already-in-use|email-already/i.test(dupErr.code || dupErr.message),
    dupErr?.code);

  console.log(`\n${fail === 0 ? "ALL PHASE 1 ACCEPTANCE TESTS PASSED" : `${fail} FAILED`}  (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
