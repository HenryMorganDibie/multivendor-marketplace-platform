import { https } from "firebase-functions/v2";
import * as crypto from "crypto";
import { db, FieldValue, Timestamp, auth } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";

/**
 * Phone OTP — secondary phone number verification via SMS.
 *
 * ARCHITECTURE NOTE:
 * Firebase Auth's native phone sign-in (`signInWithPhoneNumber` on the
 * client) handles the PRIMARY phone auth flow automatically — the client
 * SDK talks to Firebase Auth, which sends the SMS and verifies the code
 * without any Cloud Function needed. That flow is already supported in
 * Phase 1 because `onUserCreate` fires for phone-authenticated users too.
 *
 * These functions handle a DIFFERENT use case:
 *   - A vendor or customer wants to VERIFY or ADD a phone number to their
 *     profile AFTER signing up (e.g. they signed in with email but want to
 *     add their WhatsApp number for order notifications).
 *   - Or: verify a phone number for business contact purposes independent
 *     of Auth sign-in.
 *
 * SMS delivery:
 *   In the emulator, the OTP code is stored in Firestore at
 *   `phoneOtps/{hashedPhone}` and can be read by the test suite using the
 *   Admin SDK (the test reads the code directly from Firestore, same
 *   pattern as emailOtps).
 *
 *   In production, set the `SMS_PROVIDER` environment variable to route
 *   through your chosen provider. Two options are pre-wired:
 *     - Africa's Talking (recommended for Nigeria — writes to `smsQueue/{docId}`)
 *     - Twilio (writes to `smsQueue/{docId}` with provider: 'twilio')
 *   Use the Trigger SMS extension or a Cloud Function listening on
 *   `smsQueue` to dispatch the actual SMS.
 *
 * Security:
 *   - Doc ID is SHA-256 hash of the normalized phone number (no PII exposure)
 *   - Code is SHA-256 hashed before storage (same as emailOtps)
 *   - Max 5 sends per hour per number
 *   - Max 5 verify attempts before lockout
 *   - 10-minute expiry
 */

const OTP_LENGTH = 6;
const OTP_EXPIRY_MINUTES = 10;
const MAX_SEND_PER_HOUR = 5;
const MAX_VERIFY_ATTEMPTS = 5;

function generateOtp(): string {
  return crypto.randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, "0");
}

function hashCode(code: string, phone: string): string {
  return crypto.createHash("sha256").update(`${phone}:${code}`).digest("hex");
}

function phoneDocId(phone: string): string {
  return crypto.createHash("sha256").update(normalizePhone(phone)).digest("hex");
}

/**
 * Normalizes a Nigerian/international phone number to E.164 format.
 * Accepts: 08012345678, +2348012345678, 2348012345678
 * Returns: +2348012345678
 */
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("234") && digits.length === 13) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 11) return `+234${digits.slice(1)}`;
  if (digits.length === 10) return `+234${digits}`;
  // Already E.164-style digits or international
  return `+${digits}`;
}

function isValidPhone(phone: string): boolean {
  // Must be E.164 after normalization: + followed by 7-15 digits
  return /^\+\d{7,15}$/.test(phone);
}

// ─── sendPhoneOtp ─────────────────────────────────────────────────────────────

export const sendPhoneOtp = https.onCall(async (request): Promise<{ success: true }> => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "sendPhoneOtp");

  const rawPhone = String(request.data?.phoneNumber ?? "").trim();
  if (!rawPhone) {
    throw new https.HttpsError("invalid-argument", "phoneNumber is required.");
  }

  const phone = normalizePhone(rawPhone);
  if (!isValidPhone(phone)) {
    throw new https.HttpsError(
      "invalid-argument",
      `"${rawPhone}" is not a valid phone number. ` +
      `Use formats like 08012345678, +2348012345678, or 2348012345678.`
    );
  }

  const otpRef = db.collection("phoneOtps").doc(phoneDocId(phone));
  const now = Timestamp.now();
  const oneHourAgo = Timestamp.fromMillis(now.toMillis() - 60 * 60 * 1000);

  let rateLimited = false;
  let codeForEmulator: string | null = null;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(otpRef);
    const data = snap.exists ? snap.data()! : null;

    let sendCount = 1;
    if (data?.firstSendAt && (data.firstSendAt as Timestamp).toMillis() > oneHourAgo.toMillis()) {
      sendCount = (data.sendCount ?? 0) + 1;
      if (sendCount > MAX_SEND_PER_HOUR) {
        rateLimited = true;
        return;
      }
    }

    const code = generateOtp();
    codeForEmulator = code;
    const expiresAt = Timestamp.fromMillis(now.toMillis() + OTP_EXPIRY_MINUTES * 60 * 1000);

    tx.set(otpRef, {
      // Phone number NOT stored in plaintext — doc ID is the hashed phone
      codeHash: hashCode(code, phone),
      expiresAt,
      verifyAttempts: 0,
      sendCount,
      firstSendAt: sendCount === 1 ? now : (data?.firstSendAt ?? now),
      createdAt: now,
    });

    // Queue SMS for delivery via extension or background function
    // In the emulator this doc is readable by the test suite (Admin SDK only)
    tx.set(db.collection("smsQueue").doc(), {
      to: phone,
      provider: process.env.SMS_PROVIDER ?? "emulator",
      message: `Your the platform verification code is ${code}. ` +
               `It expires in ${OTP_EXPIRY_MINUTES} minutes. ` +
               `Do not share this code with anyone.`,
      // Store the code in emulator-only field so tests can extract it
      ...(process.env.FUNCTIONS_EMULATOR === "true" ? { _emulatorCode: code } : {}),
      createdAt: now,
    });
  });

  if (rateLimited) {
    await writeAuditLog({
      requestId,
      functionName: "sendPhoneOtp",
      actorUid: request.auth?.uid ?? null,
      actorRole: "customer",
      actorType: request.auth ? "customer" : "system",
      targetType: "phoneOtp",
      targetId: phoneDocId(phone),
      eventType: "phone_otp.rate_limited",
      metadata: { maxPerHour: MAX_SEND_PER_HOUR },
      appCheck,
    });
    throw new https.HttpsError(
      "resource-exhausted",
      "Too many OTP requests for this number. Please wait before trying again."
    );
  }

  return { success: true };
});

// ─── verifyPhoneOtp ───────────────────────────────────────────────────────────

export const verifyPhoneOtp = https.onCall(
  async (request): Promise<{ success: true; verified: true }> => {
    const requestId = newRequestId();
    const appCheck = checkAppCheck(request, "verifyPhoneOtp");

    const rawPhone = String(request.data?.phoneNumber ?? "").trim();
    const code = String(request.data?.code ?? "").trim();

    if (!rawPhone || !code) {
      throw new https.HttpsError("invalid-argument", "phoneNumber and code are required.");
    }

    const phone = normalizePhone(rawPhone);
    if (!isValidPhone(phone)) {
      throw new https.HttpsError("invalid-argument", "Invalid phone number format.");
    }

    const otpRef = db.collection("phoneOtps").doc(phoneDocId(phone));

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(otpRef);

      if (!snap.exists) {
        throw new https.HttpsError(
          "not-found",
          "No verification code found for this number. Please request a new one."
        );
      }

      const data = snap.data()!;
      const now = Timestamp.now();

      if ((data.expiresAt as Timestamp).toMillis() < now.toMillis()) {
        tx.delete(otpRef);
        throw new https.HttpsError(
          "deadline-exceeded",
          "This code has expired. Please request a new one."
        );
      }

      const attempts = (data.verifyAttempts ?? 0) + 1;

      if (data.codeHash !== hashCode(code, phone)) {
        if (attempts >= MAX_VERIFY_ATTEMPTS) {
          tx.delete(otpRef);
          throw new https.HttpsError(
            "resource-exhausted",
            "Too many incorrect attempts. Please request a new code."
          );
        }
        tx.update(otpRef, { verifyAttempts: attempts });
        throw new https.HttpsError(
          "invalid-argument",
          `Incorrect code. ${MAX_VERIFY_ATTEMPTS - attempts} attempt${MAX_VERIFY_ATTEMPTS - attempts === 1 ? "" : "s"} remaining.`
        );
      }

      // Code is correct — delete the OTP doc
      tx.delete(otpRef);
    });

    // If the caller is signed in, update their phone number on the profile
    if (request.auth) {
      const uid = request.auth.uid;

      await db.collection("users").doc(uid).update({
        phoneNumber: phone,
        updatedAt: FieldValue.serverTimestamp(),
      });

      // Also update Firebase Auth phone number if different
      const userRecord = await auth.getUser(uid).catch(() => null);
      if (userRecord && userRecord.phoneNumber !== phone) {
        await auth.updateUser(uid, { phoneNumber: phone }).catch(() => null);
      }

      await writeAuditLog({
        requestId,
        functionName: "verifyPhoneOtp",
        actorUid: uid,
        actorRole: "customer",
        actorType: "customer",
        targetType: "user",
        targetId: uid,
        eventType: "user.phone_verified",
        after: { phoneVerified: true },
        appCheck,
      });
    }

    return { success: true, verified: true };
  }
);
