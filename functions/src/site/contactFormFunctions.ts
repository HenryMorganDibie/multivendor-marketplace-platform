import { https } from "firebase-functions/v2";
import * as crypto from "crypto";
import { db, FieldValue, Timestamp } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { enforceRateLimit } from "../subscriptions/rateLimit";
import { ContactSubmissionDoc, WaitlistSubmissionDoc } from "../types4";

/**
 * Public contact form — LANDING_PAGE_CMS_VENDOR_PORTAL_MAPPING.md Section 3.
 *
 * Support inbox address needs the client's confirmation (Section 3: "designated
 * the platform support inbox"); using a placeholder until that's provided. No
 * visitor acknowledgement email is sent, per the section's stated MVP
 * default.
 */
const SUPPORT_INBOX = process.env.CONTACT_FORM_SUPPORT_INBOX ?? "support@the platform.com";

const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 254;
const MAX_SUBJECT_LENGTH = 100;
const MAX_MESSAGE_LENGTH = 4000;
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

function requireField(value: unknown, field: string, maxLength: number): string {
  const str = String(value ?? "").trim();
  if (!str) {
    throw new https.HttpsError("invalid-argument", `${field} is required.`);
  }
  if (str.length > maxLength) {
    throw new https.HttpsError("invalid-argument", `${field} exceeds maximum length of ${maxLength}.`);
  }
  return str;
}

function messageHash(message: string): string {
  return crypto.createHash("sha256").update(message.trim().toLowerCase()).digest("hex");
}

/**
 * submitContactForm — public, unauthenticated. Writes to
 * contactSubmissions, never a direct client write. status/createdAt/source
 * are always server-owned (never accepted from request.data).
 */
export const submitContactForm = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "submitContactForm");

  const ip = request.rawRequest?.ip ?? "unknown";
  await enforceRateLimit(`public:${ip}`, "submitContactForm", 5);

  const data = request.data as
    | { name?: unknown; email?: unknown; subjectCategory?: unknown; message?: unknown; honeypot?: unknown }
    | undefined;

  // Honeypot — hidden from real users; a filled value indicates a bot.
  if (typeof data?.honeypot === "string" && data.honeypot.trim().length > 0) {
    // Silently accept without writing anything, so the bot gets no signal
    // that it was detected.
    return { success: true };
  }

  const name = requireField(data?.name, "name", MAX_NAME_LENGTH);
  const email = requireField(data?.email, "email", MAX_EMAIL_LENGTH).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new https.HttpsError("invalid-argument", "A valid email address is required.");
  }
  const subjectCategory = requireField(data?.subjectCategory, "subjectCategory", MAX_SUBJECT_LENGTH);
  const message = requireField(data?.message, "message", MAX_MESSAGE_LENGTH);

  // Basic duplicate/spam detection: identical message content submitted
  // repeatedly within a short window is flagged spam rather than rejected
  // outright, so a genuine retry after a network error isn't silently lost.
  const hash = messageHash(message);
  const dupWindowStart = Timestamp.fromMillis(Date.now() - DUPLICATE_WINDOW_MS);
  const dupSnap = await db
    .collection("contactSubmissions")
    .where("messageHash", "==", hash)
    .where("createdAt", ">=", dupWindowStart)
    .limit(1)
    .get();
  const isDuplicate = !dupSnap.empty;

  const submissionRef = db.collection("contactSubmissions").doc();
  const now = FieldValue.serverTimestamp();

  const doc: ContactSubmissionDoc & { messageHash: string } = {
    submissionId: submissionRef.id,
    name,
    email,
    subjectCategory,
    message,
    status: isDuplicate ? "spam" : "new",
    source: "public_website",
    createdAt: now,
    messageHash: hash,
  };
  await submissionRef.set(doc);

  if (!isDuplicate) {
    await db.collection("mail").add({
      to: [SUPPORT_INBOX],
      message: {
        subject: `New contact form submission: ${subjectCategory}`,
        text: `From: ${name} <${email}>\nCategory: ${subjectCategory}\n\n${message}`,
        html: `<p><strong>From:</strong> ${name} &lt;${email}&gt;</p><p><strong>Category:</strong> ${subjectCategory}</p><p>${message.replace(/\n/g, "<br>")}</p>`,
      },
    });
  }

  await writeAuditLog({
    requestId,
    functionName: "submitContactForm",
    actorUid: null,
    actorRole: "system",
    actorType: "system",
    targetType: "contactSubmissions",
    targetId: submissionRef.id,
    eventType: isDuplicate ? "contactForm.duplicate_flagged" : "contactForm.submitted",
    appCheck,
  });

  return { success: true };
});

/**
 * joinWaitlist — public, unauthenticated. Section 1.1's "not available in
 * this country yet" state on the Pricing page and Vendor Portal offers a
 * waitlist signup instead of a dead end. Writes to waitlistSubmissions,
 * never a direct client write. One entry per email+country pair — a
 * repeat submission updates the timestamp rather than creating a
 * duplicate row, so re-clicking the button isn't destructive but also
 * doesn't spam the notification inbox.
 */
export const joinWaitlist = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "joinWaitlist");

  const ip = request.rawRequest?.ip ?? "unknown";
  await enforceRateLimit(`public:${ip}`, "joinWaitlist", 5);

  const data = request.data as { email?: unknown; countryCode?: unknown } | undefined;
  const email = requireField(data?.email, "email", MAX_EMAIL_LENGTH).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new https.HttpsError("invalid-argument", "A valid email address is required.");
  }
  const countryCode = requireField(data?.countryCode, "countryCode", 100);

  const docId = crypto.createHash("sha256").update(`${email}:${countryCode}`).digest("hex");
  const ref = db.collection("waitlistSubmissions").doc(docId);
  const existing = await ref.get();
  const now = FieldValue.serverTimestamp();

  const doc: WaitlistSubmissionDoc = {
    email,
    countryCode,
    createdAt: existing.exists ? (existing.data() as WaitlistSubmissionDoc).createdAt : now,
    updatedAt: now,
  };
  await ref.set(doc);

  await writeAuditLog({
    requestId,
    functionName: "joinWaitlist",
    actorUid: null,
    actorRole: "system",
    actorType: "system",
    targetType: "waitlistSubmissions",
    targetId: docId,
    eventType: existing.exists ? "waitlist.resubmitted" : "waitlist.joined",
    appCheck,
  });

  return { success: true };
});
