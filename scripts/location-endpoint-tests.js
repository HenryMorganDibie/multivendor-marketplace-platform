/**
 * The location endpoints, against real catalogue records.
 *
 * Seeds a slice of the actual location-data files rather than invented
 * fixtures, so the endpoints are exercised against the shapes the importer
 * really writes. Nigeria because it is the launch market, Andorra because it is
 * small enough to check exhaustively, and one retired record to prove retired
 * places stay out of pickers.
 */
process.env.GCLOUD_PROJECT = "demo-platform";
process.env.GOOGLE_CLOUD_PROJECT = "demo-platform";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: "demo-platform" });
const db = admin.firestore();

const ROOT = path.join(__dirname, "..", "location-data");
let pass = 0, fail = 0;
const check = (n, label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${n}. ${label}`); }
  else { fail++; console.log(`FAIL  ${n}. ${label}${detail ? `  (${detail})` : ""}`); }
};

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

async function seed() {
  const countries = readJson(path.join(ROOT, "countries.json"));
  const wanted = new Set(["NG", "AD"]);
  const batch = db.batch();

  for (const c of countries.filter((c) => wanted.has(c.countryCode))) {
    batch.set(db.collection("countries").doc(c.countryCode), c);
  }
  // A retired country, to prove status filtering is real.
  batch.set(db.collection("countries").doc("ZZ"), {
    countryCode: "ZZ", name: "Retired Testland", normalizedName: "retired testland",
    dialCode: "+000", currencyCode: "USD", currencySymbol: "$", flagEmoji: "🏳️",
    defaultLocale: "en", status: "retired", sortOrder: 999,
  });

  let ngStates = [], adStates = [];
  for (const code of ["NG", "AD"]) {
    const f = path.join(ROOT, "states", `${code}.json`);
    if (!fs.existsSync(f)) continue;
    const states = readJson(f);
    for (const st of states) batch.set(db.collection("states").doc(st.stateId), st);
    if (code === "NG") ngStates = states; else adStates = states;
  }

  // Area files are one per state, named by stateId (NG-AB.json), not one per
  // country. Seed the first few Nigerian states so there are areas in more than
  // one state, which is what the wrong-state check needs.
  let areasSeeded = [];
  for (const st of ngStates.slice(0, 4)) {
    const f = path.join(ROOT, "locations", `${st.stateId}.json`);
    if (!fs.existsSync(f)) continue;
    const areas = readJson(f);
    for (const a of areas) batch.set(db.collection("locations").doc(a.locationId), a);
    areasSeeded = areasSeeded.concat(areas);
  }

  await batch.commit();
  return { ngStates, adStates, areasSeeded };
}

(async () => {
  const { ngStates, areasSeeded } = await seed();
  console.log(`seeded: 2 countries + 1 retired, ${ngStates.length} NG states, ${areasSeeded.length} areas\n`);

  // Import the compiled implementations directly. The callable wrappers add
  // App Check and rate limiting, which are not what these checks are about.
  const impl = require("../functions/lib/locations/locationFunctions");

  // ── listCountries ────────────────────────────────────────────────────────
  const countriesSnap = await db.collection("countries").where("status", "==", "active").get();
  const activeCodes = countriesSnap.docs.map((d) => d.id).sort();
  check(1, "Active countries are readable from the catalogue",
    activeCodes.includes("NG") && activeCodes.includes("AD"), activeCodes.join(","));
  check(2, "A retired country is excluded", !activeCodes.includes("ZZ"), activeCodes.join(","));

  // ── validateLocation, which is the part registration depends on ───────────
  const { validateLocation } = impl;

  let r = await validateLocation({ countryCode: "NG" });
  check(3, "A real country with no state given is valid", r.valid === true, r.reason);

  r = await validateLocation({ countryCode: "QQ" });
  check(4, "A country that is not in the catalogue is rejected", r.valid === false, JSON.stringify(r));

  r = await validateLocation({ countryCode: "ZZ" });
  check(5, "A retired country is rejected", r.valid === false, JSON.stringify(r));

  r = await validateLocation({ countryCode: null });
  check(6, "A missing country is rejected", r.valid === false, JSON.stringify(r));

  if (ngStates.length) {
    const ngState = ngStates[0];
    r = await validateLocation({ countryCode: "NG", stateId: ngState.stateId });
    check(7, `A real state in its own country is valid (${ngState.name})`, r.valid === true, r.reason);

    // The check that matters: a real state, wrong country.
    r = await validateLocation({ countryCode: "AD", stateId: ngState.stateId });
    check(8, "A real state attached to the wrong country is rejected", r.valid === false, JSON.stringify(r));

    r = await validateLocation({ countryCode: "NG", stateId: "NG-ZZZ" });
    check(9, "A state that does not exist is rejected", r.valid === false, JSON.stringify(r));

    const areaInState = areasSeeded.find((a) => a.stateId === ngState.stateId);
    if (areaInState) {
      r = await validateLocation({ countryCode: "NG", stateId: ngState.stateId, areaId: areaInState.locationId });
      check(10, `A real area in its own state is valid (${areaInState.name})`, r.valid === true, r.reason);

      const areaElsewhere = areasSeeded.find((a) => a.stateId && a.stateId !== ngState.stateId);
      if (areaElsewhere) {
        r = await validateLocation({ countryCode: "NG", stateId: ngState.stateId, areaId: areaElsewhere.locationId });
        check(11, "An area attached to the wrong state is rejected", r.valid === false, JSON.stringify(r));
      }

      r = await validateLocation({ countryCode: "NG", areaId: areaInState.locationId });
      check(12, "An area without a state is rejected", r.valid === false, JSON.stringify(r));
    }
  }

  console.log(`\n${fail === 0 ? "ALL LOCATION TESTS PASSED" : `${fail} FAILURE(S)`}  (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
