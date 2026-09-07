import { https } from "firebase-functions/v2";
import { db } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { enforceRateLimit } from "../subscriptions/rateLimit";

/**
 * Read access to the location catalogue.
 *
 * The catalogue has been in Firestore since the importer ran, but nothing read
 * it: the app carried 17 countries and 134 areas hardcoded, so a vendor in any
 * of the other 179 countries could not register. These three callables are what
 * the app reads instead.
 *
 * Unauthenticated on purpose. Registration is the first place the list is
 * needed, and nobody has an account at that point. The data is a public
 * reference list of place names, so there is nothing to protect; the rate limit
 * is about cost and abuse, not confidentiality.
 *
 * Only `status: "active"` records are returned. The catalogue keeps retired
 * places so historical addresses still resolve, but a retired place must never
 * appear in a picker.
 */

/** Shapes returned to the client. Deliberately narrower than the stored
 *  documents: the app needs a label and an id, not normalizedName or slug. */
interface CountryOption {
  countryCode: string;
  name: string;
  dialCode: string | null;
  currencyCode: string | null;
  flagEmoji: string | null;
}

interface StateOption {
  stateId: string;
  stateCode: string;
  name: string;
  type: string | null;
}

interface AreaOption {
  locationId: string;
  name: string;
  locationType: string | null;
  timeZone: string | null;
}

/** Alphabetical within sortOrder, so a picker reads predictably. */
function bySortOrderThenName<T extends { name: string; sortOrder?: number }>(a: T, b: T): number {
  const ao = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
  const bo = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
  if (ao !== bo) return ao - bo;
  return a.name.localeCompare(b.name);
}

/**
 * listCountries — every country a vendor or customer may register in.
 */
export const listCountries = https.onCall(async (request) => {
  checkAppCheck(request, "listCountries");
  const ip = request.rawRequest?.ip ?? "unknown";
  await enforceRateLimit(`locations:${ip}`, "listCountries", 60);

  const snap = await db.collection("countries").where("status", "==", "active").get();

  const countries: (CountryOption & { sortOrder?: number })[] = [];
  snap.forEach((doc) => {
    const d = doc.data();
    countries.push({
      countryCode: d.countryCode,
      name: d.name,
      dialCode: d.dialCode ?? null,
      currencyCode: d.currencyCode ?? null,
      flagEmoji: d.flagEmoji ?? null,
      sortOrder: d.sortOrder,
    });
  });
  countries.sort(bySortOrderThenName);

  return { success: true, countries: countries.map(({ sortOrder, ...rest }) => rest) };
});

/**
 * listStates — the states, provinces or regions of one country.
 *
 * Returns an empty array rather than an error for a country with no states on
 * file. That is a real state of the catalogue for small territories, and the
 * caller should show "no states" rather than an error, because nothing failed.
 */
export const listStates = https.onCall(async (request) => {
  checkAppCheck(request, "listStates");
  const ip = request.rawRequest?.ip ?? "unknown";
  await enforceRateLimit(`locations:${ip}`, "listStates", 120);

  const countryCode = (request.data?.countryCode ?? "").toString().trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw new https.HttpsError("invalid-argument", "A two-letter country code is required.");
  }

  const snap = await db
    .collection("states")
    .where("countryCode", "==", countryCode)
    .where("status", "==", "active")
    .get();

  const states: (StateOption & { sortOrder?: number })[] = [];
  snap.forEach((doc) => {
    const d = doc.data();
    states.push({
      stateId: d.stateId,
      stateCode: d.stateCode,
      name: d.name,
      type: d.type ?? null,
      sortOrder: d.sortOrder,
    });
  });
  states.sort(bySortOrderThenName);

  return { success: true, countryCode, states: states.map(({ sortOrder, ...rest }) => rest) };
});

/**
 * listAreas — the areas or cities within one state.
 *
 * Same empty-not-error rule as listStates. Plenty of states legitimately have
 * no separate areas, and the app already handles that by hiding the area step.
 */
export const listAreas = https.onCall(async (request) => {
  checkAppCheck(request, "listAreas");
  const ip = request.rawRequest?.ip ?? "unknown";
  await enforceRateLimit(`locations:${ip}`, "listAreas", 120);

  const stateId = (request.data?.stateId ?? "").toString().trim().toUpperCase();
  if (!stateId || stateId.length > 32) {
    throw new https.HttpsError("invalid-argument", "A stateId is required.");
  }

  const snap = await db
    .collection("locations")
    .where("stateId", "==", stateId)
    .where("status", "==", "active")
    .get();

  const areas: (AreaOption & { sortOrder?: number })[] = [];
  snap.forEach((doc) => {
    const d = doc.data();
    areas.push({
      locationId: d.locationId,
      name: d.name,
      locationType: d.locationType ?? null,
      timeZone: d.timeZone ?? null,
      sortOrder: d.sortOrder,
    });
  });
  areas.sort(bySortOrderThenName);

  return { success: true, stateId, areas: areas.map(({ sortOrder, ...rest }) => rest) };
});

/**
 * Confirms a country/state/area combination exists in the catalogue and that
 * the parts belong together.
 *
 * Used by registration so a saved location cannot be a place that does not
 * exist, or a real state attached to the wrong country. Client-side pickers
 * cannot guarantee either: a caller can send any payload it likes.
 *
 * Exported for direct use by other functions rather than only as a callable,
 * because completeRegistration needs it inside its own flow.
 */
export async function validateLocation(input: {
  countryCode?: string | null;
  stateId?: string | null;
  areaId?: string | null;
}): Promise<{ valid: boolean; reason?: string }> {
  const countryCode = (input.countryCode ?? "").trim().toUpperCase();
  if (!countryCode) return { valid: false, reason: "A country is required." };

  const countrySnap = await db.collection("countries").doc(countryCode).get();
  if (!countrySnap.exists || countrySnap.data()?.status !== "active") {
    return { valid: false, reason: `${countryCode} is not an available country.` };
  }

  // State is optional at registration, so absence is valid. A state that is
  // present must exist and must sit in the country given.
  const stateId = (input.stateId ?? "").trim().toUpperCase();
  if (stateId) {
    const stateSnap = await db.collection("states").doc(stateId).get();
    if (!stateSnap.exists || stateSnap.data()?.status !== "active") {
      return { valid: false, reason: "That state is not in the location catalogue." };
    }
    if (stateSnap.data()?.countryCode !== countryCode) {
      return { valid: false, reason: "That state does not belong to the country given." };
    }
  }

  const areaId = (input.areaId ?? "").trim().toUpperCase();
  if (areaId) {
    if (!stateId) {
      return { valid: false, reason: "An area cannot be given without a state." };
    }
    const areaSnap = await db.collection("locations").doc(areaId).get();
    if (!areaSnap.exists || areaSnap.data()?.status !== "active") {
      return { valid: false, reason: "That area is not in the location catalogue." };
    }
    if (areaSnap.data()?.stateId !== stateId) {
      return { valid: false, reason: "That area does not belong to the state given." };
    }
  }

  return { valid: true };
}

/** Callable wrapper, so the app can check a selection before submitting. */
export const validateLocationSelection = https.onCall(async (request) => {
  checkAppCheck(request, "validateLocationSelection");
  const ip = request.rawRequest?.ip ?? "unknown";
  await enforceRateLimit(`locations:${ip}`, "validateLocationSelection", 120);

  const result = await validateLocation({
    countryCode: request.data?.countryCode,
    stateId: request.data?.stateId,
    areaId: request.data?.areaId,
  });
  return { success: true, ...result };
});
