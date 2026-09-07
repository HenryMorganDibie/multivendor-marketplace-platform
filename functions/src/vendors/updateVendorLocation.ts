import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";

const AREA_CHANGE_COOLDOWN_DAYS = 90;

/**
 * How long after a change further edits still count as fixing that same
 * change rather than starting a new one.
 *
 * Without this the cooldown was a trap. Enforcing "once every 90 days"
 * literally meant the second save in a session locked the vendor out until
 * November: setting a location and then immediately correcting a mis-picked
 * area — or simply tapping Save twice, which this screen makes easy with a
 * header button and a footer button — was indistinguishable from moving the
 * business. It was hit on the very first real use.
 */
const CORRECTION_WINDOW_HOURS = 24;

/**
 * updateVendorLocation — the state/area half of a vendor's business location.
 *
 * Signup deliberately captures country only (currency, plan pricing and
 * country availability are all resolved from it immediately); state and area
 * are left to this onboarding step. Nothing implemented that step: the
 * business-location screen's area picker only ever set local component
 * state, and it filtered a hardcoded three-country area table by a state the
 * vendor had no way to set — so the list was always empty and the
 * business_location checklist item could never be completed by anyone.
 *
 * Country is intentionally not accepted here. Changing it would invalidate
 * the currency and pricing resolved at signup, which is why the screen shows
 * it locked.
 *
 * The 90-day cooldown the screen has always advertised is enforced here
 * rather than in the UI, where it lived in a useState that reset to null on
 * every reload and therefore never applied. Setting a location for the first
 * time is not a change and is never blocked.
 */
export const updateVendorLocation = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "updateVendorLocation");

  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string;

  const state = String(request.data?.state ?? "").trim();
  const area = String(request.data?.area ?? "").trim();
  const stateId = request.data?.stateId ? String(request.data.stateId).trim() : null;
  const areaId = request.data?.areaId ? String(request.data.areaId).trim() : null;

  if (!state) {
    throw new https.HttpsError("invalid-argument", "State / province is required.");
  }

  const vendorRef = db.collection("vendors").doc(vendorId);
  const vendorSnap = await vendorRef.get();
  if (!vendorSnap.exists) {
    throw new https.HttpsError("not-found", "Vendor profile not found.");
  }
  const before = vendorSnap.data() ?? {};

  // A vendor who has never had a state set is completing onboarding, not
  // changing anything — the cooldown must not lock them out of their own
  // first setup.
  const hadLocation = Boolean(String(before.state ?? "").trim());
  const unchanged = String(before.state ?? "").trim() === state
    && String(before.area ?? "").trim() === area;

  const lastChangedAt = before.locationChangedAt?.toDate?.() as Date | undefined;
  const hoursSinceLastChange = lastChangedAt
    ? (Date.now() - lastChangedAt.getTime()) / (60 * 60 * 1000)
    : Infinity;
  const isCorrection = hoursSinceLastChange <= CORRECTION_WINDOW_HOURS;

  if (hadLocation && !unchanged && !isCorrection && lastChangedAt) {
    const daysSince = Math.floor(hoursSinceLastChange / 24);
    if (daysSince < AREA_CHANGE_COOLDOWN_DAYS) {
      const daysLeft = AREA_CHANGE_COOLDOWN_DAYS - daysSince;
      throw new https.HttpsError(
        "failed-precondition",
        `You can change your business area again in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`
      );
    }
  }

  const updates: Record<string, unknown> = {
    state,
    region: state,
    area,
    city: area,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (stateId) updates.stateId = stateId;
  if (areaId) updates.areaId = areaId;
  // The clock starts on a genuine change and is deliberately NOT restarted by
  // corrections inside the window above — otherwise each fix would push the
  // 90 days out again, so a vendor tidying up their area on the first day
  // would end up locked out for longer than one who left it wrong.
  if (hadLocation && !unchanged && !isCorrection) {
    updates.locationChangedAt = FieldValue.serverTimestamp();
  }

  await vendorRef.update(updates);

  await writeAuditLog({
    requestId,
    functionName: "updateVendorLocation",
    actorUid: request.auth.uid,
    actorRole: "vendor",
    actorType: "vendor",
    targetType: "vendor",
    targetId: vendorId,
    eventType: "vendor.location_updated",
    before: { state: before.state, area: before.area },
    after: { state, area },
    appCheck,
  });

  return { success: true };
});
