import { https } from "firebase-functions/v2";
import { admin, db, FieldValue } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { resolveEffectivePlan } from "../subscriptions/resolveEffectivePlan";

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const ALLOWED_LOGO_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const MAX_THANK_YOU_LENGTH = 280;
const MAX_FOOTER_LENGTH = 500;

/**
 * updateInvoiceBranding (Phase 4, Section 5.8).
 *
 * Every field is checked against PlanLimits before any write — a field
 * not permitted by the vendor's current plan throws permission-denied and
 * nothing is saved, including the fields that WOULD have been permitted
 * (no partial saves; the caller resubmits without the disallowed field).
 * logoUrl is validated against the real Cloud Storage object (content
 * type, size), never the client-supplied claim, matching the pattern
 * already used for vendor verification documents.
 */
export const updateInvoiceBranding = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "updateInvoiceBranding");

  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string;
  const {
    logoUrl, brandColor, thankYouMessage, footerText,
    selectedTemplateId, selectedSeasonalThemeId, qrCodeEnabled, printLayoutEnabled,
  } = request.data ?? {};

  const { limits: planLimits } = await resolveEffectivePlan(vendorId);
  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp(), updatedByUid: request.auth.uid };

  if (logoUrl !== undefined) {
    if (!planLimits.canUploadLogo) throw new https.HttpsError("permission-denied", "Uploading a logo is not available on your current plan.");
    if (logoUrl !== null) {
      if (typeof logoUrl !== "string" || !logoUrl.startsWith(`invoiceBranding/${vendorId}/`)) {
        throw new https.HttpsError("invalid-argument", `logoUrl must reference an uploaded object under invoiceBranding/${vendorId}/.`);
      }
      const file = admin.storage().bucket().file(logoUrl);
      const [exists] = await file.exists();
      if (!exists) throw new https.HttpsError("failed-precondition", "No uploaded file found at the given logoUrl. Upload the file first.");
      const [metadata] = await file.getMetadata();
      const contentType = metadata.contentType ?? "";
      const sizeBytes = Number(metadata.size ?? 0);
      if (!ALLOWED_LOGO_MIME_TYPES.includes(contentType)) {
        throw new https.HttpsError("invalid-argument", `Logo must be PNG, JPEG, or WebP (got "${contentType}").`);
      }
      if (sizeBytes > MAX_LOGO_BYTES) {
        throw new https.HttpsError("invalid-argument", `Logo must be ${MAX_LOGO_BYTES / 1024 / 1024}MB or smaller.`);
      }
    }
    updates.logoUrl = logoUrl;
  }

  if (brandColor !== undefined) {
    if (!planLimits.canSetBrandColor) throw new https.HttpsError("permission-denied", "Setting a brand color is not available on your current plan.");
    if (brandColor !== null && !HEX_COLOR_PATTERN.test(brandColor)) {
      throw new https.HttpsError("invalid-argument", "brandColor must be a 6-digit hex color, e.g. #1A2B3C.");
    }
    updates.brandColor = brandColor;
  }

  if (thankYouMessage !== undefined) {
    if (!planLimits.canSetThankYouMessage) throw new https.HttpsError("permission-denied", "Setting a thank-you message is not available on your current plan.");
    if (thankYouMessage !== null && String(thankYouMessage).length > MAX_THANK_YOU_LENGTH) {
      throw new https.HttpsError("invalid-argument", `thankYouMessage must be ${MAX_THANK_YOU_LENGTH} characters or fewer.`);
    }
    updates.thankYouMessage = thankYouMessage;
  }

  if (footerText !== undefined) {
    if (!planLimits.canSetFooterText) throw new https.HttpsError("permission-denied", "Setting footer text is not available on your current plan.");
    if (footerText !== null && String(footerText).length > MAX_FOOTER_LENGTH) {
      throw new https.HttpsError("invalid-argument", `footerText must be ${MAX_FOOTER_LENGTH} characters or fewer.`);
    }
    updates.footerText = footerText;
  }

  if (selectedTemplateId !== undefined) {
    if (!planLimits.canUsePremiumTemplates) throw new https.HttpsError("permission-denied", "Premium templates are not available on your current plan.");
    updates.selectedTemplateId = selectedTemplateId;
  }

  if (selectedSeasonalThemeId !== undefined) {
    if (!planLimits.canUseSeasonalThemes) throw new https.HttpsError("permission-denied", "Seasonal themes are not available on your current plan.");
    updates.selectedSeasonalThemeId = selectedSeasonalThemeId;
  }

  if (qrCodeEnabled !== undefined) {
    if (!planLimits.canAddQrCode) throw new https.HttpsError("permission-denied", "QR codes are not available on your current plan.");
    updates.qrCodeEnabled = qrCodeEnabled === true;
  }

  if (printLayoutEnabled !== undefined) {
    if (!planLimits.canUsePrintLayout) throw new https.HttpsError("permission-denied", "Print layout is not available on your current plan.");
    updates.printLayoutEnabled = printLayoutEnabled === true;
  }

  // Additive-only from the vendor's perspective (Section 10 guarantee): a
  // downgrade never clears or mutates saved branding here. Plan filtering
  // happens only at invoice generation time, in invoicePdf.ts.
  await db.collection("invoiceBranding").doc(vendorId).set(updates, { merge: true });

  await writeAuditLog({
    requestId,
    functionName: "updateInvoiceBranding",
    actorUid: request.auth.uid,
    actorRole: "vendor",
    actorType: "vendor",
    targetType: "invoiceBranding",
    targetId: vendorId,
    eventType: "invoice_branding.updated",
    appCheck,
  });

  return { success: true };
});
