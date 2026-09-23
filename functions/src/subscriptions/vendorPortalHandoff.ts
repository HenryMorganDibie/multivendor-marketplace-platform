import { https } from "firebase-functions/v2";
import { auth } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";

const PORTAL_BASE_URL = process.env.VENDOR_PORTAL_URL ?? "https://vendor.example.com";

/**
 * generateVendorPortalHandoffUrl — the missing half of "Manage billing on
 * the web". The mobile screen has always expected a signed, vendor-specific
 * portalUrl (see openVendorPortal.ts's own comment); nothing ever generated
 * one. Firebase custom tokens are already short-lived (~1 hour) and
 * cryptographically signed by the Admin SDK, so there's no need for a
 * separate one-time-token store — the portal exchanges this token via
 * signInWithCustomToken and every callable it then calls still independently
 * re-checks role/vendorId server-side, same as a normal portal session.
 */
export const generateVendorPortalHandoffUrl = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "generateVendorPortalHandoffUrl");

  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string | undefined;
  if (!vendorId) throw new https.HttpsError("failed-precondition", "Vendor ID could not be determined.");

  const destination = typeof request.data?.destination === "string" ? request.data.destination : "/subscription";
  const allowedDestinations = new Set(["/subscription", "/billing"]);
  const safeDestination = allowedDestinations.has(destination) ? destination : "/subscription";

  const token = await auth.createCustomToken(request.auth.uid, { vendorId });
  const portalUrl = `${PORTAL_BASE_URL}/portal-handoff?token=${encodeURIComponent(token)}&dest=${encodeURIComponent(safeDestination)}`;

  await writeAuditLog({
    requestId, functionName: "generateVendorPortalHandoffUrl", actorUid: request.auth.uid, actorRole: "vendor", actorType: "vendor",
    targetType: "vendor", targetId: vendorId, eventType: "vendor.portal_handoff_generated",
    before: null, after: { destination: safeDestination }, appCheck,
  });

  return { success: true, portalUrl };
});
