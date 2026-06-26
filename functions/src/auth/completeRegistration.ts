import { https, logger } from "firebase-functions/v2";
import { db, FieldValue, auth } from "../admin";
import {
  CompleteRegistrationRequest,
  VendorDoc,
  VendorVerificationDoc,
} from "../types";
import { writeAuditLog } from "../utils/auditLog";
import { checkAppCheck } from "../utils/appCheck";
import { newRequestId } from "../utils/requestContext";
import { reserveUsername } from "./usernameReservation";

/**
 * completeRegistration — finalizes role selection and (for vendors)
 * creates vendors/{vendorId} + vendorVerification/{vendorId}, reserves
 * the username, and sets custom claims with an incremented claimsVersion.
 *
 * Architecture doc references: 4.1, 4.6, 4.7, section 5 "submitVendorApplication".
 */
export const completeRegistration = https.onCall(
  async (request): Promise<{ success: true; role: string; vendorId?: string }> => {
    const requestId = newRequestId();
    const appCheck = checkAppCheck(request, "completeRegistration");

    if (!request.auth) {
      throw new https.HttpsError("unauthenticated", "Sign in required.");
    }

    const uid = request.auth.uid;
    const data = request.data as CompleteRegistrationRequest;

    if (data.role !== "customer" && data.role !== "vendor") {
      throw new https.HttpsError("invalid-argument", "role must be 'customer' or 'vendor'.");
    }

    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      throw new https.HttpsError("failed-precondition", "User profile not found. Auth trigger may not have run yet.");
    }

    const existingRole = userSnap.data()?.role;
    if (existingRole === "vendor" || existingRole === "admin") {
      throw new https.HttpsError(
        "failed-precondition",
        "Account role has already been finalized and cannot be changed via this function."
      );
    }

    const currentClaimsVersion = (userSnap.data()?.claimsVersion as number | undefined) ?? 1;
    const newClaimsVersion = currentClaimsVersion + 1;

    if (data.role === "customer") {
      await userRef.update({
        role: "customer",
        claimsVersion: newClaimsVersion,
        "profile.firstName": data.firstName ?? null,
        "profile.lastName": data.lastName ?? null,
        "profile.fullName":
          data.firstName && data.lastName ? `${data.firstName} ${data.lastName}` : null,
        "profile.countryCode": data.countryCode ?? null,
        "profile.region": data.region ?? null,
        "profile.city": data.city ?? null,
        "profile.area": data.area ?? null,
        "onboarding.completed": true,
        "onboarding.completedAt": FieldValue.serverTimestamp(),
        "onboarding.currentStep": "done",
        updatedAt: FieldValue.serverTimestamp(),
      });

      await auth.setCustomUserClaims(uid, { role: "customer", claimsVersion: newClaimsVersion });

      await writeAuditLog({
        requestId,
        functionName: "completeRegistration",
        actorUid: uid,
        actorRole: "customer",
        actorType: "customer",
        targetType: "user",
        targetId: uid,
        eventType: "user.onboarding_completed",
        message: "Customer onboarding completed.",
        appCheck,
      });

      return { success: true, role: "customer" };
    }

    // ---------------- Vendor registration ----------------

    if (!data.businessName || !data.username) {
      throw new https.HttpsError(
        "invalid-argument",
        "businessName and username are required for vendor registration."
      );
    }

    const vendorId = uid;

    await reserveUsername(data.username, vendorId);

    const now = FieldValue.serverTimestamp();

    const vendorDoc: VendorDoc = {
      vendorId,
      ownerUid: uid,
      username: data.username,
      slug: data.username,
      name: data.businessName,
      businessName: data.businessName,
      categoryId: data.categoryId,
      category: data.categoryName,
      categoryName: data.categoryName,

      countryCode: data.country,
      country: data.country,
      region: data.state,
      state: data.state,
      area: data.area,

      verificationStatus: "not_started",
      vendorStatus: "active",
      isVerified: false,
      isPublished: false,
      isDiscoverable: false,

      plan: data.plan ?? "basic",

      ratingAverage: 0,
      ratingCount: 0,
      orderCount: 0,
      recentOrders7Days: 0,
      ordersLast48h: 0,
      profileViews: 0,
      favoritesCount: 0,

      createdAt: now,
      updatedAt: now,
    };

    const verificationDoc: VendorVerificationDoc = {
      vendorId,
      ownerUid: uid,
      verificationStatus: "not_started",
      type: "individual",
      requiredSteps: ["business_info", "identity_document", "proof_of_address"],
      documentCount: 0,
      manualReviewStatus: "pending",
      createdAt: now,
      updatedAt: now,
    };

    const batch = db.batch();
    batch.set(db.collection("vendors").doc(vendorId), vendorDoc);
    batch.set(db.collection("vendorVerification").doc(vendorId), verificationDoc);
    batch.update(userRef, {
      role: "vendor",
      vendorId,
      claimsVersion: newClaimsVersion,
      "profile.fullName": data.fullName ?? null,
      "profile.countryCode": data.country ?? null,
      "profile.region": data.state ?? null,
      "profile.area": data.area ?? null,
      "onboarding.completed": true,
      "onboarding.completedAt": now,
      "onboarding.currentStep": "vendor_pending_verification",
      updatedAt: now,
    });

    await batch.commit();

    await auth.setCustomUserClaims(uid, {
      role: "vendor",
      vendorId,
      claimsVersion: newClaimsVersion,
    });

    await writeAuditLog({
      requestId,
      functionName: "completeRegistration",
      actorUid: uid,
      actorRole: "vendor",
      actorType: "vendor",
      targetType: "vendor",
      targetId: vendorId,
      eventType: "vendor.registered",
      message: `Vendor account created for "${data.businessName}" (@${data.username}).`,
      after: { vendorId, username: data.username, plan: vendorDoc.plan },
      appCheck,
    });

    logger.info(`Vendor ${vendorId} registered with username @${data.username}`, { requestId });

    return { success: true, role: "vendor", vendorId };
  }
);

/**
 * refreshUserClaims — callable so the frontend can request a fresh token
 * after any backend-initiated claims change (e.g. admin approves vendor,
 * suspends account). Returns the current claimsVersion so the client can
 * decide whether `getIdToken(true)` is needed.
 */
export const getClaimsVersion = https.onCall(async (request): Promise<{ claimsVersion: number }> => {
  if (!request.auth) {
    throw new https.HttpsError("unauthenticated", "Sign in required.");
  }

  const userSnap = await db.collection("users").doc(request.auth.uid).get();
  const claimsVersion = (userSnap.data()?.claimsVersion as number | undefined) ?? 1;

  return { claimsVersion };
});
