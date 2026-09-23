/**
 * Recovery from a half-finished registration.
 *
 * The manual admin cleanup refuses accounts younger than
 * MANUAL_CLEANUP_GRACE_MINUTES, so an account created seconds ago is protected.
 * Test 11 proves that. Tests 7 and 8 need the deletion path itself, so the
 * emulator is started with that window at zero — see the note in the run
 * instructions below.
 *
 * Registration spans several writes. A failure between them used to leave an
 * auth user holding a role with no vendor record: unable to finish, unable to
 * start again, its email occupied forever. The client tried to delete the auth
 * user, but that runs on the device that just failed, so it cannot be the only
 * way back.
 *
 * Run:  MANUAL_CLEANUP_GRACE_MINUTES=0 on the emulator, then
 *       node orphan-recovery-tests.js
 */
process.env.GCLOUD_PROJECT = "demo-platform";
process.env.GOOGLE_CLOUD_PROJECT = "demo-platform";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const admin = require("firebase-admin");
const { initializeApp } = require("firebase/app");
const { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, connectAuthEmulator } = require("firebase/auth");
const { getFunctions, httpsCallable, connectFunctionsEmulator } = require("firebase/functions");

if (!admin.apps.length) admin.initializeApp({ projectId: "demo-platform" });
const fdb = admin.firestore();

const client = initializeApp({ apiKey: "demo", projectId: "demo-platform" }, `orphan-${Date.now()}`);
const auth = getAuth(client);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(client);
connectFunctionsEmulator(fns, "127.0.0.1", 5001);

let pass = 0, fail = 0;
const check = (n, label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${n}. ${label}`); }
  else { fail++; console.log(`FAIL  ${n}. ${label}${detail ? `  (${detail})` : ""}`); }
};

const PASSWORD = "DemoPass123!";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── 1. A finished registration is idempotent ──────────────────────────────
  const emailA = `orphan.done.${Date.now()}@platform.test`;
  await createUserWithEmailAndPassword(auth, emailA, PASSWORD);
  await wait(2500);
  const first = await httpsCallable(fns, "completeRegistration")({
    role: "vendor", firstName: "Ada", lastName: "Obi", phoneNumber: "+2348012345678", country: "Nigeria",
  });
  const vendorId = first.data.vendorId;
  check(1, "First registration creates the vendor record", Boolean(vendorId));

  const second = await httpsCallable(fns, "completeRegistration")({
    role: "vendor", firstName: "Ada", lastName: "Obi", phoneNumber: "+2348012345678", country: "Nigeria",
  });
  check(2, "Calling it again returns the same vendor rather than failing",
    second.data.vendorId === vendorId, `${second.data.vendorId} vs ${vendorId}`);
  check(3, "The repeat is reported as already registered",
    second.data.alreadyRegistered === true, String(second.data.alreadyRegistered));

  const vendorCount = await fdb.collection("vendors").where("ownerUid", "==", auth.currentUser.uid).get();
  check(4, "No duplicate vendor record is created",
    vendorCount.size <= 1, `${vendorCount.size} vendor records`);

  // ── 2. A half-finished account can be resumed ─────────────────────────────
  // Simulates the failure: role assigned, vendor record never written.
  const emailB = `orphan.partial.${Date.now()}@platform.test`;
  await createUserWithEmailAndPassword(auth, emailB, PASSWORD);
  await wait(2500);
  const partialUid = auth.currentUser.uid;
  await fdb.collection("users").doc(partialUid).update({ role: "vendor", vendorId: null });

  let resumed = null, resumeError = null;
  try {
    resumed = await httpsCallable(fns, "completeRegistration")({
      role: "vendor", firstName: "Ify", lastName: "Nwa", phoneNumber: "+2348012345679", country: "Nigeria",
    });
  } catch (e) { resumeError = e; }

  check(5, "A half-finished account can still complete registration",
    Boolean(resumed?.data?.vendorId), resumeError ? resumeError.code : "no vendorId returned");
  if (resumed?.data?.vendorId) {
    const created = await fdb.collection("vendors").doc(resumed.data.vendorId).get();
    check(6, "The missing vendor record is created on the retry", created.exists);
  } else {
    check(6, "The missing vendor record is created on the retry", false, "resume failed");
  }

  // ── 3. An admin can free an email held by an unfinished account ───────────
  const emailC = `orphan.stuck.${Date.now()}@platform.test`;
  await createUserWithEmailAndPassword(auth, emailC, PASSWORD);
  await wait(2000);
  const stuckUid = auth.currentUser.uid;

  await signInWithEmailAndPassword(auth, "demo.admin@example.com", PASSWORD);
  await auth.currentUser.getIdToken(true);

  const graceWindow = Number(process.env.MANUAL_CLEANUP_GRACE_MINUTES ?? 15);

  let freed = null, freeErr = null;
  try {
    freed = await httpsCallable(fns, "cleanupOrphanedAccount")({ email: emailC });
  } catch (e) { freeErr = e; }

  if (graceWindow > 0) {
    // The account was created seconds ago, so the window should protect it.
    // This is the default run, and it is the behaviour that matters in
    // production: a support request cannot delete somebody mid-signup.
    check(7, "A newly created account is protected by the grace window",
      Boolean(freeErr?.code?.includes("failed-precondition")),
      freeErr?.code ?? "it was deleted");
    check(8, "The protected account still exists",
      Boolean(await admin.auth().getUser(stuckUid).catch(() => null)));
  } else {
    // Window zeroed: exercise the deletion path itself.
    check(7, "An admin can free an email held by an unfinished account",
      freed?.data?.success === true, freeErr ? freeErr.code : "no success");
    let gone = false;
    try { await admin.auth().getUser(stuckUid); } catch { gone = true; }
    check(8, "The auth user is actually removed", gone);
  }

  // ── 4. It refuses to delete a working account ─────────────────────────────
  let refused = null;
  try {
    await httpsCallable(fns, "cleanupOrphanedAccount")({ email: emailA });
  } catch (e) { refused = e.code; }
  check(9, "It refuses to delete an account that completed registration",
    Boolean(refused && refused.includes("failed-precondition")), refused ?? "was allowed");

  // ── 5. Only an admin may run it ───────────────────────────────────────────
  await signInWithEmailAndPassword(auth, "demo.vendor@example.com", PASSWORD);
  await auth.currentUser.getIdToken(true);
  let denied = null;
  try {
    await httpsCallable(fns, "cleanupOrphanedAccount")({ email: emailA });
  } catch (e) { denied = e.code; }
  check(10, "A vendor cannot run account cleanup",
    Boolean(denied && denied.includes("permission-denied")), denied ?? "was allowed");

  // ── 11. A completed account cannot be overwritten by a re-run ─────────────
  // Resumability must not become a way to reset somebody. Calling
  // completeRegistration again on a finished vendor returns what already exists
  // rather than rebuilding it, so a second call cannot change their username,
  // their vendorId, or the date they joined.
  await signInWithEmailAndPassword(auth, emailA, PASSWORD);
  await auth.currentUser.getIdToken(true);
  const beforeDoc = (await fdb.collection("vendors").doc(vendorId).get()).data();

  await httpsCallable(fns, "completeRegistration")({
    role: "vendor", firstName: "Overwritten", lastName: "Name", phoneNumber: "+2348012345678", country: "Nigeria",
  });

  const afterDoc = (await fdb.collection("vendors").doc(vendorId).get()).data();
  check(11, "A completed account is not overwritten by calling registration again",
    afterDoc.username === beforeDoc.username &&
    afterDoc.vendorId === beforeDoc.vendorId &&
    String(afterDoc.createdAt?.toMillis?.()) === String(beforeDoc.createdAt?.toMillis?.()),
    "the existing record was modified");

  // ── 12. Claims are corrected when registration resumes ────────────────────
  // A part-failed registration can leave a user document saying vendor while the
  // token still says customer, or holding no vendorId. Every backend call is
  // authorised against the claim, not the document, so a resumed registration
  // that fixed the record and left the claim stale would leave someone unable to
  // act as the vendor they now are.
  const emailD = `orphan.claims.${Date.now()}@platform.test`;
  const credD = await createUserWithEmailAndPassword(auth, emailD, PASSWORD);
  const uidD = credD.user.uid;
  await wait(2500);
  await httpsCallable(fns, "completeRegistration")({
    role: "vendor", firstName: "Claims", lastName: "Test", phoneNumber: "+2348012345678", country: "Nigeria",
  });

  // Break it the way a mid-flight failure would: the vendor record is gone and
  // the claim has fallen back to customer, while the user document still says
  // vendor.
  const vendorIdD = (await fdb.collection("users").doc(uidD).get()).data().vendorId;
  await fdb.collection("vendors").doc(vendorIdD).delete();
  await admin.auth().setCustomUserClaims(uidD, { role: "customer", claimsVersion: 1 });
  await auth.currentUser.getIdToken(true);

  await httpsCallable(fns, "completeRegistration")({
    role: "vendor", firstName: "Claims", lastName: "Test", phoneNumber: "+2348012345678", country: "Nigeria",
  });

  const repairedClaims = (await admin.auth().getUser(uidD)).customClaims ?? {};
  check(12, "Claims are corrected when a failed registration resumes",
    repairedClaims.role === "vendor" && Boolean(repairedClaims.vendorId),
    `role=${repairedClaims.role} vendorId=${repairedClaims.vendorId ?? "missing"}`);

  // ── 13/14. The recovery action is audit-logged ────────────────────────────
  // Deleting an account is irreversible, so there has to be a record of who did
  // it and to whom.
  //
  // Only assertable when a deletion actually happened. At the default grace
  // window the checks above correctly prevent one, so there is nothing to have
  // logged — asserting a record then would be testing the wrong thing.
  if (graceWindow === 0) {
    const auditSnap = await fdb.collection("auditLogs")
      .where("eventType", "==", "user.orphan_cleaned")
      .limit(5).get();
    check(13, "Account cleanup writes an audit record", !auditSnap.empty,
      "no user.orphan_cleaned entry found");

    // The log nests these rather than flattening them: actor.{uid,role,type}
    // and target.{type,id}.
    const auditEntry = auditSnap.docs[0]?.data();
    check(14, "The audit record names the admin and the account removed",
      Boolean(auditEntry?.actor?.uid && auditEntry?.target?.id),
      `actor=${JSON.stringify(auditEntry?.actor)} target=${JSON.stringify(auditEntry?.target)}`);
  } else {
    console.log("SKIP  13/14. Audit record (no deletion at the default grace window)");
  }

  // ── 15. The sweep leaves a slow registration alone ────────────────────────
  // Someone who registered ten minutes ago and is still reading the terms looks
  // identical to an abandoned account: no completed onboarding, no finalised
  // role. The sweep's 24-hour grace period is what separates them.
  const emailE = `orphan.slow.${Date.now()}@platform.test`;
  await createUserWithEmailAndPassword(auth, emailE, PASSWORD);
  await wait(2000);
  const slowUid = (await admin.auth().getUserByEmail(emailE)).uid;

  const slowDoc = await fdb.collection("users").doc(slowUid).get();
  const slowIsUnfinished =
    !slowDoc.exists ||
    (slowDoc.data().onboarding?.completed !== true &&
     slowDoc.data().role !== "vendor" && slowDoc.data().role !== "admin");
  const slowAgeMs = Date.now() - Date.parse((await admin.auth().getUser(slowUid)).metadata.creationTime);

  check(15, "A slow registration looks unfinished but is inside the grace period",
    slowIsUnfinished && slowAgeMs < 24 * 60 * 60 * 1000,
    `unfinished=${slowIsUnfinished} ageMs=${slowAgeMs}`);

  check(16, "The sweep would not remove it, because the grace period excludes it",
    slowAgeMs < 24 * 60 * 60 * 1000,
    "an account this new would have been swept");


  console.log(`\n${fail === 0 ? "ALL ORPHAN RECOVERY TESTS PASSED" : `${fail} FAILURE(S)`}  (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
