import { https } from "firebase-functions/v2";
import * as crypto from "crypto";
import { db, FieldValue, Timestamp, auth } from "../admin";
import { writeAuditLog } from "../utils/auditLog";
import { checkAppCheck } from "../utils/appCheck";
import { newRequestId } from "../utils/requestContext";

/**
 * Email OTP — email-only verification (confirmed 2026-06-11, no SMS).
 *
 * PII fix (audit finding): the `emailOtps` document ID is now a SHA-256
 * hash of the normalized email, not the raw email address, to avoid
 * exposing PII in document IDs (visible in console/logs).
 */

const OTP_LENGTH = 6;
const OTP_EXPIRY_MINUTES = 10;
const MAX_SEND_ATTEMPTS_PER_HOUR = 5;
const MAX_VERIFY_ATTEMPTS = 5;

function generateOtp(): string {
  const num = crypto.randomInt(0, 10 ** OTP_LENGTH);
  return num.toString().padStart(OTP_LENGTH, "0");
}

function hashOtp(code: string, email: string): string {
  return crypto.createHash("sha256").update(`${email}:${code}`).digest("hex");
}

function emailDocId(email: string): string {
  return crypto.createHash("sha256").update(email).digest("hex");
}

// ---------------------------------------------------------------------------
// sendEmailOtp
// ---------------------------------------------------------------------------
export const sendEmailOtp = https.onCall(async (request): Promise<{ success: true }> => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "sendEmailOtp");

  const email = String(request.data?.email ?? "").trim().toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new https.HttpsError("invalid-argument", "A valid email address is required.");
  }

  const otpRef = db.collection("emailOtps").doc(emailDocId(email));
  const now = Timestamp.now();
  const oneHourAgo = Timestamp.fromMillis(now.toMillis() - 60 * 60 * 1000);

  let rateLimited = false;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(otpRef);
    const data = snap.exists ? snap.data() : null;

    let sendCount = 1;
    if (data?.firstSendAt && (data.firstSendAt as Timestamp).toMillis() > oneHourAgo.toMillis()) {
      sendCount = (data.sendCount ?? 0) + 1;
      if (sendCount > MAX_SEND_ATTEMPTS_PER_HOUR) {
        rateLimited = true;
        return;
      }
    }

    const code = generateOtp();
    const expiresAt = Timestamp.fromMillis(now.toMillis() + OTP_EXPIRY_MINUTES * 60 * 1000);

    tx.set(otpRef, {
      // email itself NOT stored in plaintext on the doc; only the hash (doc ID).
      codeHash: hashOtp(code, email),
      expiresAt,
      verifyAttempts: 0,
      sendCount,
      firstSendAt: sendCount === 1 ? now : data?.firstSendAt ?? now,
      createdAt: now,
    });

    tx.set(db.collection("mail").doc(), {
      to: [email],
      message: {
        subject: "Your the platform verification code",
        text: `Your the platform verification code is ${code}. It expires in ${OTP_EXPIRY_MINUTES} minutes. If you didn't request this, you can ignore this email.`,
        html: `<p>Your the platform verification code is:</p><h2 style="letter-spacing:4px">${code}</h2><p>This code expires in ${OTP_EXPIRY_MINUTES} minutes. If you didn't request this, you can ignore this email.</p>`,
      },
    });
  });

  if (rateLimited) {
    await writeAuditLog({
      requestId,
      functionName: "sendEmailOtp",
      actorUid: request.auth?.uid ?? null,
      actorRole: "customer",
      actorType: request.auth ? "customer" : "system",
      targetType: "emailOtp",
      targetId: emailDocId(email),
      eventType: "email_otp.rate_limited",
      metadata: { maxPerHour: MAX_SEND_ATTEMPTS_PER_HOUR },
      appCheck,
    });

    throw new https.HttpsError(
      "resource-exhausted",
      "Too many OTP requests for this email. Please try again later."
    );
  }

  return { success: true };
});

// ---------------------------------------------------------------------------
// verifyEmailOtp
// ---------------------------------------------------------------------------
export const verifyEmailOtp = https.onCall(
  async (request): Promise<{ success: true; verified: true }> => {
    const requestId = newRequestId();
    const appCheck = checkAppCheck(request, "verifyEmailOtp");

    const email = String(request.data?.email ?? "").trim().toLowerCase();
    const code = String(request.data?.code ?? "").trim();

    if (!email || !code) {
      throw new https.HttpsError("invalid-argument", "email and code are required.");
    }

    const otpRef = db.collection("emailOtps").doc(emailDocId(email));

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(otpRef);

      if (!snap.exists) {
        throw new https.HttpsError("not-found", "No verification code found for this email. Please request a new one.");
      }

      const data = snap.data()!;
      const now = Timestamp.now();

      if ((data.expiresAt as Timestamp).toMillis() < now.toMillis()) {
        tx.delete(otpRef);
        throw new https.HttpsError("deadline-exceeded", "This code has expired. Please request a new one.");
      }

      const attempts = (data.verifyAttempts ?? 0) + 1;

      if (data.codeHash !== hashOtp(code, email)) {
        if (attempts >= MAX_VERIFY_ATTEMPTS) {
          tx.delete(otpRef);
          throw new https.HttpsError(
            "resource-exhausted",
            "Too many incorrect attempts. Please request a new code."
          );
        }
        tx.update(otpRef, { verifyAttempts: attempts });
        throw new https.HttpsError("invalid-argument", "Incorrect code. Please try again.");
      }

      tx.delete(otpRef);
    });

    if (request.auth) {
      const uid = request.auth.uid;
      const userRecord = await auth.getUser(uid).catch(() => null);

      if (userRecord?.email?.toLowerCase() === email) {
        await auth.updateUser(uid, { emailVerified: true });
        await db.collection("users").doc(uid).update({
          updatedAt: FieldValue.serverTimestamp(),
        });

        await writeAuditLog({
          requestId,
          functionName: "verifyEmailOtp",
          actorUid: uid,
          actorRole: "customer",
          actorType: "customer",
          targetType: "user",
          targetId: uid,
          eventType: "user.email_verified",
          appCheck,
        });
      }
    }

    return { success: true, verified: true };
  }
);
