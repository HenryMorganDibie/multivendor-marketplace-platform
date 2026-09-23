/**
 * Customer registration, against the live project.
 *
 * The smoke test only ever registered a vendor, so the fix to
 * completeRegistration was verified for one of the two roles it serves. The
 * fix is role-agnostic — it writes users/{uid} before the role is decided — but
 * "should work for customers too" is a claim, and this makes it a measurement.
 *
 *   DEV_API_KEY=... GOOGLE_APPLICATION_CREDENTIALS=... node customer-registration-check.js
 */
const admin = require("firebase-admin");
const { initializeApp } = require("firebase/app");
const { getAuth, createUserWithEmailAndPassword } = require("firebase/auth");
const { getFunctions, httpsCallable } = require("firebase/functions");

const PROJECT = "platform-dev";
const API_KEY = process.env.DEV_API_KEY;
if (!API_KEY) { console.error("Set DEV_API_KEY."); process.exit(1); }

if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
const fdb = admin.firestore();

const client = initializeApp(
  { apiKey: API_KEY, authDomain: `${PROJECT}.firebaseapp.com`, projectId: PROJECT },
  `cust-${Date.now()}`,
);
const auth = getAuth(client);
const fns = getFunctions(client);

let pass = 0, fail = 0;
const check = (n, label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${n}. ${label}`); }
  else { fail++; console.log(`FAIL  ${n}. ${label}${detail ? `  (${detail})` : ""}`); }
};

async function main() {
  const stamp = Date.now();
  const email = `smoke.customer.${stamp}@platform-dev.test`;

  console.log(`\nCustomer registration against LIVE ${PROJECT}\n`);

  await createUserWithEmailAndPassword(auth, email, "SmokePass123!");

  /**
   * Deliberately no wait for onUserCreate.
   *
   * The app used to poll for users/{uid} for ten seconds before calling, and
   * losing that race is what broke registration. Calling immediately is the
   * worst case, so it is what gets tested.
   */
  const reg = await httpsCallable(fns, "completeRegistration")({
    role: "customer",
    firstName: "Smoke",
    lastName: "Customer",
    phoneNumber: `+23480${String(stamp).slice(-8)}`,
    country: "Nigeria",
    countryCode: "NG",
    region: "Lagos",
    area: "Ikeja",
  });

  check(1, "Customer registers with no wait for the auth trigger", reg.data.success === true);
  check(2, "Role comes back as customer", reg.data.role === "customer", reg.data.role);
  check(3, "No vendorId is issued to a customer",
    !reg.data.vendorId, String(reg.data.vendorId));

  const uid = auth.currentUser.uid;
  const userDoc = (await fdb.collection("users").doc(uid).get()).data();
  check(4, "A user profile exists in Firestore", Boolean(userDoc), "missing");
  check(5, "The stored role is customer", userDoc?.role === "customer", userDoc?.role);

  // The location the customer was made to pick has to survive. A marketplace
  // that sells itself on vendors near you cannot discard the region.
  check(6, "Region and area are stored, not discarded",
    Boolean(userDoc?.profile?.region) && Boolean(userDoc?.profile?.area),
    JSON.stringify({ region: userDoc?.profile?.region, area: userDoc?.profile?.area }));

  await auth.currentUser.getIdToken(true);
  const claims = (await auth.currentUser.getIdTokenResult()).claims;
  check(7, "Custom claims carry role=customer", claims.role === "customer", String(claims.role));
  check(8, "A customer gets no vendorId claim", !claims.vendorId, String(claims.vendorId));

  console.log(`\n${fail === 0 ? "CUSTOMER REGISTRATION PASSED" : `${fail} FAILURE(S)`}  (${pass} passed)`);
  console.log(`Test customer: ${email}  /  SmokePass123!`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("\nFATAL:", e.message); process.exit(1); });
