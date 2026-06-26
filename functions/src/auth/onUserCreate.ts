import { auth as functionsAuth } from "firebase-functions/v1";
import { db, admin, auth, FieldValue } from "../admin";
import { UserDoc } from "../types";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";

/**
 * Triggered when a new Firebase Auth user is created.
 *
 * - Creates `users/{uid}` with safe defaults and `claimsVersion: 1`.
 * - Sets default custom claims `{ role: 'customer', claimsVersion: 1 }`.
 *   Vendor role is finalized later via `completeRegistration`.
 *
 * Architecture doc reference: section 4.1, section 5 "onUserCreate".
 */
export const onUserCreate = functionsAuth.user().onCreate(async (user) => {
  const uid = user.uid;
  const requestId = newRequestId();

  await auth.setCustomUserClaims(uid, { role: "customer", claimsVersion: 1 });

  const userDoc: UserDoc = {
    uid,
    email: user.email ?? null,
    phoneNumber: user.phoneNumber ?? null,
    displayName: user.displayName ?? null,
    photoURL: user.photoURL ?? null,

    role: "customer",
    accountStatus: "active",
    vendorId: null,
    claimsVersion: 1,

    onboarding: {
      completed: false,
      completedAt: null,
      currentStep: "role_selection",
    },

    profile: {},

    notificationPreferences: {
      orderUpdates: true,
      messages: true,
      promotions: true,
      support: true,
    },

    privacy: {
      profileVisibility: "public",
      allowVendorMessages: true,
      analyticsOptOut: false,
    },

    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    lastLoginAt: FieldValue.serverTimestamp(),
  };

  await db.collection("users").doc(uid).set(userDoc, { merge: true });

  await writeAuditLog({
    requestId,
    functionName: "onUserCreate",
    actorUid: uid,
    actorRole: "customer",
    actorType: "system",
    targetType: "user",
    targetId: uid,
    eventType: "user.created",
    message: "New Firebase Auth user created; default user document and customer claim assigned.",
    appCheck: { present: false, verified: null }, // auth triggers have no App Check context
  });
});
