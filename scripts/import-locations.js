/**
 * THE PLATFORM — Location Data Importer
 * Writes location-data/countries.json, states/*.json, and locations/*.json
 * to Firestore's top-level `countries`, `states`, and `locations`
 * collections, per THE PLATFORM LOCATION SPEC v1.5, Section 5-6.
 *
 * Always validates first (reuses validate-locations.js's exit code via a
 * child process) — refuses to import invalid data.
 *
 * Safe to rerun: creates new records, updates existing ones only if a
 * field actually changed (createdAt is preserved, updatedAt only refreshes
 * on a real change), and never deletes — records present in Firestore but
 * missing from the seed files are only flagged in the summary.
 *
 * Defaults to the local Firestore emulator (127.0.0.1:8080), matching every
 * other script in this folder. Pass --live to write to a real project
 * instead (requires GOOGLE_APPLICATION_CREDENTIALS or `gcloud auth
 * application-default login`, and --project <id>).
 *
 * Run: node import-locations.js
 * Run against a real project: node import-locations.js --live --project <id>
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const args = process.argv.slice(2);
const isLive = args.includes("--live");
const projectArgIdx = args.indexOf("--project");
const projectId = projectArgIdx !== -1 ? args[projectArgIdx + 1] : "demo-the platform";

if (!isLive) {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  console.log(`Target: Firestore EMULATOR (${process.env.FIRESTORE_EMULATOR_HOST}), project "${projectId}"`);
} else {
  console.log(`Target: LIVE Firestore, project "${projectId}"`);
  console.log("⚠  This will write to a real project. Ctrl+C now to abort.\n");
}

// ── Validate first — refuse to import invalid data ──────────────────────

console.log("Running validate-locations.js first...\n");
try {
  execFileSync(process.execPath, [path.join(__dirname, "validate-locations.js")], { stdio: "inherit" });
} catch {
  console.error("\nValidation failed — aborting import. Fix the errors above and rerun.");
  process.exit(1);
}
console.log("");

// ── Load data ─────────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, "..", "location-data");
const countries = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "countries.json"), "utf8"));

const statesDir = path.join(DATA_DIR, "states");
const locationsDir = path.join(DATA_DIR, "locations");
let states = [];
let locations = [];
for (const file of fs.readdirSync(statesDir).filter((f) => f.endsWith(".json"))) {
  states.push(...JSON.parse(fs.readFileSync(path.join(statesDir, file), "utf8")));
}
for (const file of fs.readdirSync(locationsDir).filter((f) => f.endsWith(".json"))) {
  locations.push(...JSON.parse(fs.readFileSync(path.join(locationsDir, file), "utf8")));
}

// ── Firebase admin ────────────────────────────────────────────────────────

const admin = require("firebase-admin");
if (!admin.apps.length) {
  admin.initializeApp(isLive ? { projectId } : { projectId });
}
const db = admin.firestore();
const { FieldValue } = admin.firestore;

// ── Upsert helper ─────────────────────────────────────────────────────────

/**
 * Shallow-compares every field in `seed` against the existing doc (ignoring
 * createdAt/updatedAt, which are never present in seed files). Returns
 * "created" | "updated" | "skipped" (no real change) | "failed".
 */
async function upsert(collection, docId, seed) {
  const ref = db.collection(collection).doc(docId);
  try {
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set({
        ...seed,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return "created";
    }

    const existing = snap.data();
    const changed = Object.keys(seed).some((key) => {
      // JSON round-trip avoids false positives from key ordering / undefined.
      return JSON.stringify(existing[key]) !== JSON.stringify(seed[key]);
    });

    if (!changed) return "skipped";

    await ref.set(
      { ...seed, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    return "updated";
  } catch (err) {
    console.error(`  FAILED ${collection}/${docId}: ${err.message}`);
    return "failed";
  }
}

async function importCollection(label, collection, records, idField) {
  const counts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const seedIds = new Set();

  for (const record of records) {
    const docId = record[idField];
    seedIds.add(docId);
    const result = await upsert(collection, docId, record);
    counts[result]++;
  }

  // Flag (never delete) Firestore records absent from the seed files.
  const existingSnap = await db.collection(collection).get();
  const orphaned = existingSnap.docs.map((d) => d.id).filter((id) => !seedIds.has(id));

  console.log(
    `${label}: ${counts.created} created, ${counts.updated} updated, ${counts.skipped} skipped, ${counts.failed} failed`
  );
  if (orphaned.length > 0) {
    console.log(`  ⚠  ${orphaned.length} existing ${collection} doc(s) not present in seed files (NOT deleted, review manually):`);
    for (const id of orphaned) console.log(`     - ${id}`);
  }
  return counts;
}

// ── Run ───────────────────────────────────────────────────────────────────

(async () => {
  console.log("Importing...\n");
  await importCollection("Countries", "countries", countries, "countryCode");
  await importCollection("States", "states", states, "stateId");
  await importCollection("Locations", "locations", locations, "locationId");
  console.log("\nDone.");
  process.exit(0);
})().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
