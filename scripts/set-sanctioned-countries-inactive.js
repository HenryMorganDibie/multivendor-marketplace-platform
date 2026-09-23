/**
 * Sets countries/{CU,IR,KP}.status to "inactive".
 *
 * validateLocation (called by completeRegistration) checks countries/{code}.status
 * === "active", not countryAvailability/{code} where these three are already
 * INACTIVE — so registration currently accepts all three sanctioned countries.
 * listCountries also filters on this same field, so this simultaneously removes
 * them from the registration country picker and makes validateLocation reject
 * any direct attempt to register with one of these codes.
 *
 * Nothing else reads countries/{code}.status (confirmed: only listCountries and
 * validateLocation; vendorCurrency.ts reads the doc but only for currencyCode),
 * so this is a narrow, side-effect-free fix — no code change needed.
 *
 *   node set-sanctioned-countries-inactive.js                       # emulator, dry run
 *   node set-sanctioned-countries-inactive.js --apply --live --project platform-dev
 */
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const LIVE = args.includes("--live");
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const PROJECT = argOf("project") ?? "demo-platform";

process.env.GCLOUD_PROJECT = PROJECT;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT;
if (!LIVE) process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

const CODES = ["CU", "IR", "KP"];

async function main() {
  console.log(`${APPLY ? "APPLYING" : "DRY RUN"} against ${LIVE ? `LIVE ${PROJECT}` : "the emulator"}\n`);

  for (const code of CODES) {
    const ref = db.collection("countries").doc(code);
    const snap = await ref.get();
    if (!snap.exists) {
      console.log(`  ${code}: no such document in countries`);
      continue;
    }
    const before = snap.data().status;
    console.log(`  ${code}: status "${before}" -> "inactive"`);
    if (APPLY) {
      await ref.update({ status: "inactive" });
    }
  }

  if (!APPLY) console.log("\nDry run only — pass --apply to write.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
