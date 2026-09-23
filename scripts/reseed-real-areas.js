/**
 * Replaces the placeholder location catalogue with real states and areas.
 *
 * Every state Platform had seeded carried exactly one "area", and that area was
 * a copy of the state's own name — Lagos state's only pickable area was
 * literally named "Lagos". And 137 of the 196 seeded countries had no state
 * data at all, so their state picker was empty and signup for those countries
 * could never complete.
 *
 * Source: dr5hn/countries-states-cities-database (MIT), a maintained open
 * dataset of real administrative divisions and real cities, used specifically
 * for this kind of cascading location picker. Its `state.iso2` field is
 * identical to the `stateCode` Platform was already using ('LA' for Lagos), and
 * `state.iso3166_2` ('NG-LA') is identical to Platform's own `stateId` format —
 * so this reseed follows Platform's existing ID convention exactly rather than
 * inventing a new one, for both states that already existed and the ones being
 * created for the first time.
 *
 * Only countries Platform has actually seeded are touched. For each of those:
 *   - every state in the dataset is upserted (existing states keep their
 *     original createdAt/sortOrder; new ones are created following the same
 *     convention)
 *   - every existing "location" (area) document under that country is deleted
 *     first, so no placeholder entry is left mixed in among the real ones
 *   - every real city from the dataset is written as a location, under its
 *     correct state
 *
 * Run:  node reseed-real-areas.js            (dry run, counts only)
 *       node reseed-real-areas.js --apply    (writes for real)
 */
const admin = require("firebase-admin");
const path = require("path");

const APPLY = process.argv.includes("--apply");
const BATCH_SIZE = 450; // Firestore's hard limit is 500 per batch.

if (!admin.apps.length) {
  admin.initializeApp({ projectId: "platform-dev" });
}
const db = admin.firestore();

function slugify(name) {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

function normalize(name) {
  return name.trim().toLowerCase();
}

async function commitInBatches(ops) {
  let committed = 0;
  for (let i = 0; i < ops.length; i += BATCH_SIZE) {
    const slice = ops.slice(i, i + BATCH_SIZE);
    if (APPLY) {
      const batch = db.batch();
      for (const op of slice) op(batch);
      await batch.commit();
    }
    committed += slice.length;
  }
  return committed;
}

async function main() {
  const dataset = require(path.join(__dirname, "geodata", "csc.json"));
  const byIso2 = new Map(dataset.map((c) => [c.iso2, c]));

  const countriesSnap = await db.collection("countries").get();
  console.log(`Platform has ${countriesSnap.size} seeded countries.\n`);

  // All existing location (area) docs, grouped by countryCode, so the old
  // placeholder for each state can be deleted before the real list is written
  // — without one query per state.
  const existingLocationsSnap = await db.collection("locations").get();
  const existingByCountry = new Map();
  for (const doc of existingLocationsSnap.docs) {
    const cc = doc.data().countryCode;
    if (!existingByCountry.has(cc)) existingByCountry.set(cc, []);
    existingByCountry.get(cc).push(doc.ref);
  }

  const existingStatesSnap = await db.collection("states").get();
  const existingStateIds = new Set(existingStatesSnap.docs.map((d) => d.id));

  let countriesMatched = 0;
  let countriesUnmatched = [];
  let statesCreated = 0, statesKept = 0;
  let locationsDeleted = 0, locationsCreated = 0;

  const deleteOps = [];
  const stateWriteOps = [];
  const locationWriteOps = [];

  for (const countryDoc of countriesSnap.docs) {
    const countryCode = countryDoc.id;
    const source = byIso2.get(countryCode);
    if (!source || !(source.states || []).length) {
      countriesUnmatched.push(countryCode);
      continue;
    }
    countriesMatched++;

    // Delete every existing area under this country — it is about to be
    // replaced wholesale with the real list, so nothing old should survive
    // mixed in with the real entries.
    for (const ref of existingByCountry.get(countryCode) || []) {
      deleteOps.push((batch) => batch.delete(ref));
      locationsDeleted++;
    }

    source.states.forEach((state, stateIndex) => {
      const stateCode = state.iso2 || `S${stateIndex + 1}`;
      const stateId = `${countryCode}-${stateCode}`;
      const stateRef = db.collection("states").doc(stateId);
      const now = admin.firestore.Timestamp.now();

      if (!existingStateIds.has(stateId)) {
        statesCreated++;
        stateWriteOps.push((batch) =>
          batch.set(stateRef, {
            stateId,
            countryCode,
            stateCode,
            name: state.name,
            normalizedName: normalize(state.name),
            type: "state",
            status: "active",
            sortOrder: stateIndex + 1,
            createdAt: now,
            updatedAt: now,
          }),
        );
      } else {
        statesKept++;
        // Existing state: touch updatedAt only, keep its original
        // createdAt/sortOrder rather than overwrite them.
        stateWriteOps.push((batch) =>
          batch.set(stateRef, { updatedAt: now }, { merge: true }),
        );
      }

      const cities = state.cities || [];
      cities.forEach((city, cityIndex) => {
        const slug = slugify(city.name);
        const locationId = `${stateId}-${slug}`;
        const locationRef = db.collection("locations").doc(locationId);
        locationsCreated++;
        locationWriteOps.push((batch) =>
          batch.set(locationRef, {
            locationId,
            countryCode,
            stateId,
            stateCode,
            name: city.name,
            normalizedName: normalize(city.name),
            slug,
            locationType: "city",
            timeZone: city.timezone || state.timezone || null,
            status: "active",
            sortOrder: cityIndex + 1,
            createdAt: now,
            updatedAt: now,
          }),
        );
      });
    });
  }

  console.log(`Matched ${countriesMatched} countries against the dataset.`);
  console.log(
    `Unmatched (no state data in the source, left as-is): ${countriesUnmatched.length}`,
    countriesUnmatched.join(", "),
  );
  console.log(`\nStates: ${statesCreated} new, ${statesKept} already existed.`);
  console.log(`Locations: ${locationsDeleted} old placeholders to delete, ${locationsCreated} real areas to write.`);
  console.log(`\n${APPLY ? "APPLYING" : "DRY RUN — pass --apply to write"}\n`);

  const deleted = await commitInBatches(deleteOps);
  console.log(`Deletes ${APPLY ? "committed" : "counted"}: ${deleted}`);

  const statesWritten = await commitInBatches(stateWriteOps);
  console.log(`State writes ${APPLY ? "committed" : "counted"}: ${statesWritten}`);

  const locationsWritten = await commitInBatches(locationWriteOps);
  console.log(`Location writes ${APPLY ? "committed" : "counted"}: ${locationsWritten}`);

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
