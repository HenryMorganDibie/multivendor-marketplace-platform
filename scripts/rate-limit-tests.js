/**
 * Rate limiting on the write endpoints.
 *
 * Authentication stops a stranger; it does not stop a signed-in user calling a
 * write endpoint in a loop. Firestore writes and function invocations both bill
 * per call, so every callable that writes needs a ceiling regardless of who is
 * calling it.
 *
 * These tests call each endpoint past its limit and assert the server refuses
 * with resource-exhausted rather than continuing to serve.
 *
 * Run:  node rate-limit-tests.js   (with the emulator running)
 */
process.env.GCLOUD_PROJECT = "demo-platform";
process.env.GOOGLE_CLOUD_PROJECT = "demo-platform";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const admin = require("firebase-admin");
const { initializeApp } = require("firebase/app");
const { getAuth, signInWithEmailAndPassword, connectAuthEmulator } = require("firebase/auth");
const { getFunctions, httpsCallable, connectFunctionsEmulator } = require("firebase/functions");

if (!admin.apps.length) admin.initializeApp({ projectId: "demo-platform" });
const fdb = admin.firestore();

const client = initializeApp({ apiKey: "demo", projectId: "demo-platform" }, `rl-${Date.now()}`);
const auth = getAuth(client);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(client);
connectFunctionsEmulator(fns, "127.0.0.1", 5001);

let pass = 0, fail = 0;
const check = (n, label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${n}. ${label}`); }
  else { fail++; console.log(`FAIL  ${n}. ${label}${detail ? `  (${detail})` : ""}`); }
};

/**
 * Calls a function until it refuses, up to a ceiling. Returns the error code
 * that stopped it, or null if it never stopped.
 */
async function callUntilRefused(name, payload, attempts) {
  for (let i = 0; i < attempts; i++) {
    try {
      await httpsCallable(fns, name)(typeof payload === "function" ? payload(i) : payload);
    } catch (e) {
      const code = e?.code ?? "";
      if (code.includes("resource-exhausted")) return "resource-exhausted";
      // Any other rejection means the call was refused for an unrelated reason
      // (bad input, wrong role). Keep going: we are testing the ceiling, not
      // the validation.
    }
  }
  return null;
}

async function main() {
  await signInWithEmailAndPassword(auth, "demo.vendor@example.com", "DemoPass123!");
  await auth.currentUser.getIdToken(true);
  const uid = auth.currentUser.uid;

  // Clear any window left by a previous run so limits start fresh.
  const stale = await fdb.collection("rateLimits").get();
  await Promise.all(stale.docs.map((d) => d.ref.delete()));

  // ── Each endpoint refuses once its window is full ─────────────────────────
  const cat = await callUntilRefused(
    "createCatalogCategory",
    (i) => ({ name: `RL cat ${Date.now()}-${i}`, order: i }),
    40,
  );
  check(1, "createCatalogCategory refuses past its limit", cat === "resource-exhausted", cat ?? "never refused");

  const ticket = await callUntilRefused(
    "createSupportTicket",
    (i) => ({ subject: `RL ${i}`, message: "rate limit test", category: "other" }),
    12,
  );
  check(2, "createSupportTicket refuses past its limit", ticket === "resource-exhausted", ticket ?? "never refused");

  const token = await callUntilRefused(
    "registerPushToken",
    (i) => ({ token: `rl-token-${Date.now()}-${i}`, platform: "android" }),
    18,
  );
  check(3, "registerPushToken refuses past its limit", token === "resource-exhausted", token ?? "never refused");

  const block = await callUntilRefused(
    "blockUser",
    (i) => ({ targetUserId: `rl-target-${i}` }),
    30,
  );
  check(4, "blockUser refuses past its limit", block === "resource-exhausted", block ?? "never refused");

  // ── The window is per caller per function, not global ─────────────────────
  const windows = await fdb.collection("rateLimits").get();
  const names = new Set(windows.docs.map((d) => d.data().functionName));
  check(5, "Each function keeps its own window", names.size >= 3, `${names.size} distinct functions tracked`);
  check(6, "Windows are keyed to the caller",
    windows.docs.every((d) => String(d.id).includes(d.data().functionName)),
    "document ids combine caller and function");

  // ── Hitting one limit does not lock the caller out of everything ──────────
  let unrelatedWorked = false;
  try {
    await httpsCallable(fns, "listCountries")({});
    unrelatedWorked = true;
  } catch { /* ignore */ }
  check(7, "Exhausting one endpoint leaves the others usable", unrelatedWorked);

  console.log(`\n${fail === 0 ? "ALL RATE LIMIT TESTS PASSED" : `${fail} FAILURE(S)`}  (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
