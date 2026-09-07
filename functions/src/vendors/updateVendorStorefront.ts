import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";

const MAX_DESCRIPTION_LENGTH = 260;
const MAX_LINK_LENGTH = 200;
const STORAGE_HOST = "https://firebasestorage.googleapis.com/";

/**
 * updateVendorStorefront — storefront appearance: logo, banner, description,
 * and contact links.
 *
 * The storefront-appearance screen wrote all of this through
 * VendorContext.updateVendor, which is AsyncStorage only. None of it ever
 * reached vendors/{vendorId}, so every edit was wiped by the next snapshot
 * from the live listener, and customers never saw any of it. The Storage
 * rules for vendorMedia/{vendorId}/logos and /banners have been deployed
 * since Milestone 4 with nothing ever uploading to them — same shape as the
 * invoice-logo gap.
 *
 * Image inputs are download URLs the client obtained after uploading to its
 * own vendorMedia path. They are checked against the Storage host and that
 * exact prefix rather than trusted: without that a vendor could point their
 * storefront logo at any URL on the internet, including one whose contents
 * change after moderation has looked at it.
 */
function assertVendorMediaUrl(
  value: unknown,
  vendorId: string,
  kind: "logos" | "banners",
  label: string
): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value) {
    throw new https.HttpsError("invalid-argument", `${label} must be a string or null.`);
  }
  if (!value.startsWith(STORAGE_HOST)) {
    throw new https.HttpsError(
      "invalid-argument",
      `${label} must be an image uploaded to Laetiva storage, not an external link.`
    );
  }
  // Storage download URLs percent-encode the object path, so the prefix
  // appears as vendorMedia%2F{vendorId}%2F{kind}%2F. Accept either form
  // rather than depending on the SDK's encoding staying identical.
  const encoded = `vendorMedia%2F${vendorId}%2F${kind}%2F`;
  const plain = `vendorMedia/${vendorId}/${kind}/`;
  if (!value.includes(encoded) && !value.includes(plain)) {
    throw new https.HttpsError(
      "invalid-argument",
      `${label} must reference a file uploaded under vendorMedia/${vendorId}/${kind}/.`
    );
  }
  return value;
}

function normalizeLink(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_LINK_LENGTH) {
    throw new https.HttpsError("invalid-argument", `${label} is too long.`);
  }
  return trimmed;
}

export const updateVendorStorefront = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "updateVendorStorefront");

  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string;

  const data = (request.data ?? {}) as Record<string, unknown>;
  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };

  if ("logoUrl" in data) {
    updates.logoUrl = assertVendorMediaUrl(data.logoUrl, vendorId, "logos", "logoUrl");
  }
  if ("coverImageUrl" in data) {
    updates.coverImageUrl = assertVendorMediaUrl(data.coverImageUrl, vendorId, "banners", "coverImageUrl");
  }

  if ("description" in data) {
    const description = data.description === null ? "" : String(data.description).trim();
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw new https.HttpsError(
        "invalid-argument",
        `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.`
      );
    }
    updates.description = description;
  }

  if ("contactLinks" in data) {
    const links = (data.contactLinks ?? {}) as Record<string, unknown>;
    updates.contactLinks = {
      website: normalizeLink(links.website, "Website"),
      instagram: normalizeLink(links.instagram, "Instagram"),
      tiktok: normalizeLink(links.tiktok, "TikTok"),
    };
  }

  if (Object.keys(updates).length === 1) {
    throw new https.HttpsError("invalid-argument", "Nothing to update.");
  }

  const vendorRef = db.collection("vendors").doc(vendorId);
  if (!(await vendorRef.get()).exists) {
    throw new https.HttpsError("not-found", "Vendor profile not found.");
  }

  await vendorRef.update(updates);

  await writeAuditLog({
    requestId,
    functionName: "updateVendorStorefront",
    actorUid: request.auth.uid,
    actorRole: "vendor",
    actorType: "vendor",
    targetType: "vendor",
    targetId: vendorId,
    eventType: "vendor.storefront_updated",
    after: { fields: Object.keys(updates).filter((k) => k !== "updatedAt") },
    appCheck,
  });

  return { success: true };
});
