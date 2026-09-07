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
import { reserveUsername, generateTemporaryUsername } from "./usernameReservation";
import { resolveCountryCode } from "../utils/countryCode";
import { validateLocation } from "../locations/locationFunctions";
import { captureLegalAcceptance } from "./legalAcceptance";

/**
 * completeRegistration — finalizes role selection and (for vendors)
 * creates vendors/{vendorId} + vendorVerification/{vendorId}, reserves
 * the username, and sets custom claims with an incremented claimsVersion.
 *
 * Architecture doc references: 4.1, 4.6, 4.7, section 5 "submitVendorApplication".
 */
export const completeRegistration = https.onCall(
  // alreadyRegistered lets a client tell "you are now registered" apart from
  // "you already were", so a retry does not show a fresh-signup screen.
  async (request): Promise<{ success: true; role: string; vendorId?: string; username?: string | null; alreadyRegistered?: boolean }> => {
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
    let userSnap = await userRef.get();

    /**
     * The profile is created here if the auth trigger has not got to it yet.
     *
     * This used to reject outright, and the app waited ten seconds for
     * onUserCreate before calling. That is a race, and the client loses it on a
     * cold trigger: registration failed, the half-made auth account was deleted
     * to avoid blocking the email, and the person saw "could not create your
     * account" with nothing wrong on their side.
     *
     * There is no reason to depend on the trigger. This function is
     * authenticated, so request.auth.uid is the account Firebase itself just
     * created — the document can simply be written. onUserCreate remains the
     * normal path and its merge is harmless when it arrives late.
     *
     * Created with role null: the role is decided below from validated input,
     * not taken from the caller here.
     */
    if (!userSnap.exists) {
      logger.info("[completeRegistration] Creating profile ahead of onUserCreate", { uid });
      await userRef.set(
        {
          uid,
          email: request.auth.token.email ?? null,
          role: null,
          claimsVersion: 1,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          createdBy: "completeRegistration",
        },
        { merge: true },
      );
      userSnap = await userRef.get();
    }

    const existingRole = userSnap.data()?.role;
    const existingVendorId = userSnap.data()?.vendorId as string | undefined;

    // An admin account is never re-registered.
    if (existingRole === "admin") {
      throw new https.HttpsError(
        "failed-precondition",
        "Account role has already been finalized and cannot be changed via this function."
      );
    }

    /**
     * Registration is several writes: the auth user, the users document, the
     * role and claims, then the vendor record and its username reservation.
     * Anything between them can fail — a dropped connection, an app killed
     * mid-flight — and this used to reject every retry with "already
     * finalized". That left the worst possible state: an account holding the
     * vendor role with no vendor record behind it, unable to finish and unable
     * to start again, with its email permanently occupied.
     *
     * So a repeat call is treated as resuming rather than as a conflict:
     *
     *   role set, vendor record exists   → already done, report success
     *   role set, vendor record missing  → finish the half-made account
     *   role not set                     → ordinary first-time registration
     *
     * The client-side deleteUser on failure stays as a fast path for the common
     * case, but it is no longer the only way back from a partial failure. It
     * cannot be, because it runs on the device that just failed.
     */
    if (existingRole === "vendor") {
      if (existingVendorId) {
        const existingVendor = await db.collection("vendors").doc(existingVendorId).get();
        if (existingVendor.exists) {
          logger.info("completeRegistration called again for a finished account; returning the existing record.", { uid, vendorId: existingVendorId });
          return {
            success: true,
            role: "vendor",
            vendorId: existingVendorId,
            username: existingVendor.data()?.username ?? null,
            alreadyRegistered: true,
          };
        }
      }
      logger.warn("Resuming a vendor registration that never finished.", { uid, existingVendorId: existingVendorId ?? null });
      // Falls through into the vendor branch below, which recreates the record.
    }

    if (data.role === "customer" && existingRole === "vendor") {
      throw new https.HttpsError(
        "failed-precondition",
        "This account is already registered as a vendor."
      );
    }

    // The location has to exist in the catalogue, and its parts have to belong
    // together. A picker cannot guarantee either: this function accepts whatever
    // the caller sends, so a request could name a country that was never
    // launched, or attach a real state to the wrong country. Checking here means
    // no account can be created against a place that does not exist.
    const resolvedCountryCode = resolveCountryCode(data.country);
    const locationCheck = await validateLocation({
      countryCode: resolvedCountryCode,
      stateId: (data as { stateId?: string }).stateId ?? null,
      areaId: (data as { areaId?: string }).areaId ?? null,
    });
    if (!locationCheck.valid) {
      throw new https.HttpsError("invalid-argument", locationCheck.reason ?? "That location is not available.");
    }

    const currentClaimsVersion = (userSnap.data()?.claimsVersion as number | undefined) ?? 1;
    const newClaimsVersion = currentClaimsVersion + 1;

    if (data.role === "customer") {
      // Which documents, at which versions, the user agreed to on the screen
      // they just submitted. Read server-side so the version cannot be claimed
      // by the client, and never rewritten when a document is republished.
      const legalAcceptance = await captureLegalAcceptance("customer");

      await userRef.update({
        role: "customer",
        legalAcceptance: { ...legalAcceptance, acceptedAt: FieldValue.serverTimestamp() },
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

    // Phase 1 progressive onboarding: a vendor registers with contact
    // details only. businessName and username are deliberately NOT required
    // here — they're collected later through the dashboard onboarding
    // checklist, and publication is gated on them instead (see
    // setVendorPublishStatus). Both are still accepted if an older client
    // sends them, so existing builds keep working.
    const vendorId = uid;

    // A system-assigned username is a placeholder the vendor is expected to
    // replace, so it's tracked separately from a name they actually chose.
    const isSystemGeneratedUsername = !data.username;

    let username: string;
    if (data.username) {
      await reserveUsername(data.username, vendorId);
      username = data.username.trim().toLowerCase();
    } else {
      username = await generateTemporaryUsername(vendorId);
    }

    const now = FieldValue.serverTimestamp();

    const vendorDoc: VendorDoc = {
      vendorId,
      ownerUid: uid,
      username,
      slug: username,
      isSystemGeneratedUsername,
      // Empty until the vendor completes onboarding. Publication is blocked
      // while these are missing rather than registration.
      name: data.businessName ?? "",
      businessName: data.businessName ?? "",
      categoryId: data.categoryId,
      category: data.categoryName,
      categoryName: data.categoryName,

      countryCode: resolveCountryCode(data.country),
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
      // Must match what the mobile verification flow actually collects
      // (verification-upload-id.tsx -> verification-selfie.tsx, "other" is
      // the selfie's honest-fit type per VerificationContext.tsx). Listing
      // business_info/proof_of_address here made submitVendorVerification's
      // requiredSteps check fail for every vendor, always, since no screen
      // anywhere in the app ever produces those two document types.
      requiredSteps: ["identity_document", "other"],
      documentCount: 0,
      manualReviewStatus: "pending",
      createdAt: now,
      updatedAt: now,
    };

    const batch = db.batch();
    batch.set(db.collection("vendors").doc(vendorId), vendorDoc);
    batch.set(db.collection("vendorVerification").doc(vendorId), verificationDoc);
    // Same server-side capture as the customer path, with the Vendor Agreement
    // in place of the Customer Agreement.
    const legalAcceptance = await captureLegalAcceptance("vendor");

    batch.update(userRef, {
      role: "vendor",
      legalAcceptance: { ...legalAcceptance, acceptedAt: FieldValue.serverTimestamp() },
      vendorId,
      claimsVersion: newClaimsVersion,
      "profile.firstName": data.firstName ?? null,
      "profile.lastName": data.lastName ?? null,
      "profile.fullName":
        data.fullName ??
        (data.firstName && data.lastName ? `${data.firstName} ${data.lastName}` : null),
      "profile.phoneNumber": data.phoneNumber ?? null,
      "profile.countryCode": resolveCountryCode(data.country),
      "profile.region": data.state ?? null,
      "profile.area": data.area ?? null,
      // The rewarded referral programme is deferred to post-MVP, but the
      // code is still captured at signup — it can never be recovered later
      // if it isn't stored now, and re-attributing a referral after the
      // fact is exactly the kind of thing that invites abuse.
      "referral.code": data.referralCode?.trim() || null,
      "referral.capturedAt": data.referralCode ? now : null,
      // Account exists and is usable, but the vendor still has storefront
      // setup ahead of them — that's what the dashboard checklist reads.
      "onboarding.completed": false,
      "onboarding.currentStep": "storefront_setup",
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
      message: data.businessName
        ? `Vendor account created for "${data.businessName}" (@${username}).`
        : `Vendor account created (@${username}) — business details pending onboarding.`,
      after: { vendorId, username, isSystemGeneratedUsername, plan: vendorDoc.plan },
      appCheck,
    });

    logger.info(
      `Vendor ${vendorId} registered with ${isSystemGeneratedUsername ? "temporary" : "chosen"} username @${username}`,
      { requestId }
    );

    return { success: true, role: "vendor", vendorId, username };
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
