import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { QuickReplyDoc, QUICK_REPLY_LIMITS } from "../types3";
import { checkAppCheck } from "../utils/appCheck";
import { newRequestId } from "../utils/requestContext";

function normalizeShortcut(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export const createQuickReply = https.onCall(async (request) => {
  checkAppCheck(request, "createQuickReply");
  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string;
  const { title, shortcut, message, sortOrder } = request.data ?? {};

  if (!title?.trim() || title.length > QUICK_REPLY_LIMITS.maxTitleLength) {
    throw new https.HttpsError("invalid-argument", `title is required, max ${QUICK_REPLY_LIMITS.maxTitleLength} characters.`);
  }
  if (!shortcut?.trim() || shortcut.length > QUICK_REPLY_LIMITS.maxShortcutLength) {
    throw new https.HttpsError("invalid-argument", `shortcut is required, max ${QUICK_REPLY_LIMITS.maxShortcutLength} characters.`);
  }
  if (!message?.trim() || message.length > QUICK_REPLY_LIMITS.maxMessageLength) {
    throw new https.HttpsError("invalid-argument", `message is required, max ${QUICK_REPLY_LIMITS.maxMessageLength} characters.`);
  }

  const normalizedShortcut = normalizeShortcut(shortcut);
  const repliesRef = db.collection("vendors").doc(vendorId).collection("quickReplies");

  const countSnap = await repliesRef.get();
  if (countSnap.size >= QUICK_REPLY_LIMITS.maxPerVendor) {
    throw new https.HttpsError(
      "resource-exhausted",
      `Maximum ${QUICK_REPLY_LIMITS.maxPerVendor} quick replies allowed.`
    );
  }

  const dupSnap = await repliesRef.where("shortcut", "==", normalizedShortcut).limit(1).get();
  if (!dupSnap.empty) {
    throw new https.HttpsError("already-exists", `Shortcut "${normalizedShortcut}" is already in use.`);
  }

  const now = FieldValue.serverTimestamp();
  const replyRef = repliesRef.doc();
  const reply: QuickReplyDoc = {
    replyId: replyRef.id,
    vendorId,
    title: title.trim(),
    shortcut: normalizedShortcut,
    message: message.trim(),
    isActive: true,
    sortOrder: typeof sortOrder === "number" ? sortOrder : 0,
    createdAt: now,
    updatedAt: now,
  };
  await replyRef.set(reply);

  return { success: true, replyId: replyRef.id };
});

export const updateQuickReply = https.onCall(async (request) => {
  checkAppCheck(request, "updateQuickReply");
  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string;
  const { replyId, title, shortcut, message, isActive, sortOrder } = request.data ?? {};
  if (!replyId) throw new https.HttpsError("invalid-argument", "replyId is required.");

  const replyRef = db.collection("vendors").doc(vendorId).collection("quickReplies").doc(replyId);
  const snap = await replyRef.get();
  if (!snap.exists) throw new https.HttpsError("not-found", "Quick reply not found.");

  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (title !== undefined) updates.title = String(title).trim().slice(0, QUICK_REPLY_LIMITS.maxTitleLength);
  if (message !== undefined) updates.message = String(message).trim().slice(0, QUICK_REPLY_LIMITS.maxMessageLength);
  if (isActive !== undefined) updates.isActive = isActive === true;
  if (sortOrder !== undefined) updates.sortOrder = Number(sortOrder);

  if (shortcut !== undefined) {
    const normalized = normalizeShortcut(shortcut);
    const dupSnap = await db.collection("vendors").doc(vendorId).collection("quickReplies")
      .where("shortcut", "==", normalized).limit(1).get();
    if (!dupSnap.empty && dupSnap.docs[0].id !== replyId) {
      throw new https.HttpsError("already-exists", `Shortcut "${normalized}" is already in use.`);
    }
    updates.shortcut = normalized;
  }

  await replyRef.update(updates);
  return { success: true };
});

export const deleteQuickReply = https.onCall(async (request) => {
  checkAppCheck(request, "deleteQuickReply");
  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string;
  const { replyId } = request.data ?? {};
  if (!replyId) throw new https.HttpsError("invalid-argument", "replyId is required.");

  const replyRef = db.collection("vendors").doc(vendorId).collection("quickReplies").doc(replyId);
  const snap = await replyRef.get();
  if (!snap.exists) throw new https.HttpsError("not-found", "Quick reply not found.");

  await replyRef.delete();
  return { success: true };
});
