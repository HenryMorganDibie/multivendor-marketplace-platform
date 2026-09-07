import { https, logger } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { NotificationDoc, NotificationDomain, PushTokenDoc,
         VendorNotificationPreferences, CustomerNotificationPreferences,
         VENDOR_NOTIFICATION_DEFAULTS, CUSTOMER_NOTIFICATION_DEFAULTS } from "../types3";
import { checkAppCheck } from "../utils/appCheck";
import { newRequestId } from "../utils/requestContext";
import { enforceRateLimit } from "../subscriptions/rateLimit";

interface CreateNotificationParams {
  recipientUid: string;
  recipientRole: "customer" | "vendor" | "admin";
  vendorId?: string | null;
  customerId?: string | null;
  type: string;
  domain: NotificationDomain;
  title: string;
  body: string;
  deepLink?: string | null;
  metadata?: Record<string, unknown>;
  isCritical: boolean;
}

/**
 * createNotificationInternal — the single path for creating a notification
 * document. Always creates the in-app doc regardless of push preferences
 * (push preferences only gate the PUSH send, never the in-app record).
 *
 * Not directly client-callable — invoked as a side effect of chat, order,
 * and verification events.
 */
export async function createNotificationInternal(
  params: CreateNotificationParams
): Promise<string> {
  // Never notify a suspended/deactivated user, and never let a missing
  // recipient blow up the calling function.
  const recipientSnap = await db.collection("users").doc(params.recipientUid).get();
  if (!recipientSnap.exists) {
    logger.warn(`createNotificationInternal: recipient ${params.recipientUid} not found — skipping`);
    return "";
  }
  const recipient = recipientSnap.data()!;
  const recipientActive = !recipient.accountStatus || recipient.accountStatus === "active";

  const now = FieldValue.serverTimestamp();
  const notifRef = db.collection("users").doc(params.recipientUid).collection("notifications").doc();

  const notification: NotificationDoc = {
    notificationId: notifRef.id,
    recipientUid: params.recipientUid,
    recipientRole: params.recipientRole,
    vendorId: params.vendorId ?? null,
    customerId: params.customerId ?? null,
    type: params.type,
    domain: params.domain,
    title: params.title,
    body: params.body,
    deepLink: params.deepLink ?? null,
    metadata: params.metadata ?? {},
    read: false,
    readAt: null,
    createdAt: now,
    expiresAt: null,
    isCritical: params.isCritical,
    pushSent: false,
    pushSentAt: null,
    pushError: null,
  };

  await notifRef.set(notification);

  // Push dispatch is best-effort and never blocks/fails notification
  // creation — the in-app record always exists regardless of push outcome.
  if (recipientActive) {
    await dispatchPush(params.recipientUid, params.recipientRole, notification, notifRef.id)
      .catch((err) => logger.error(`Push dispatch failed for ${notifRef.id}`, err));
  }

  return notifRef.id;
}

/**
 * The mobile app registers push tokens via Expo's `getExpoPushTokenAsync`
 * (`ExponentPushToken[...]`), not real FCM/APNs tokens — those only mean
 * anything to Expo's own push relay, which internally forwards to FCM/APNs
 * on Expo's own credentials. Sending one to `admin.messaging().send()`
 * directly always fails: the Firebase Admin SDK expects a real FCM
 * registration token, and an Expo token isn't one, so no push notification
 * has ever actually reached a device through this path.
 */
interface ExpoPushTicket {
  status: "ok" | "error";
  message?: string;
  details?: { error?: string };
}

async function sendExpoPush(
  token: string,
  title: string,
  body: string,
  data: Record<string, string>
): Promise<{ ok: true } | { ok: false; deviceNotRegistered: boolean; message: string }> {
  const resp = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Accept-Encoding": "gzip, deflate",
    },
    body: JSON.stringify([{ to: token, title, body, data, sound: "default", priority: "high" }]),
  });

  if (!resp.ok) {
    return { ok: false, deviceNotRegistered: false, message: `Expo push HTTP ${resp.status}` };
  }

  const json = (await resp.json()) as { data?: ExpoPushTicket[] };
  const ticket = json.data?.[0];
  if (!ticket || ticket.status === "ok") return { ok: true };

  return {
    ok: false,
    deviceNotRegistered: ticket.details?.error === "DeviceNotRegistered",
    message: ticket.message ?? "unknown Expo push error",
  };
}

/**
 * dispatchPush — checks preferences/quiet-hours, sends to all enabled
 * tokens, prunes invalid tokens, never fails the caller if one device fails.
 */
async function dispatchPush(
  recipientUid: string,
  recipientRole: "customer" | "vendor" | "admin",
  notification: NotificationDoc,
  notificationDocId: string
): Promise<void> {
  const notifRef = db.collection("users").doc(recipientUid).collection("notifications").doc(notificationDocId);

  // Resolve preferences
  let pushEnabled = true;
  let quietHoursActive = false;

  if (recipientRole === "vendor" && notification.vendorId) {
    const prefSnap = await db.collection("vendors").doc(notification.vendorId)
      .collection("settings").doc("notifications").get();
    const prefs: VendorNotificationPreferences = prefSnap.exists
      ? (prefSnap.data() as VendorNotificationPreferences)
      : { ...VENDOR_NOTIFICATION_DEFAULTS, updatedAt: FieldValue.serverTimestamp() };

    pushEnabled = prefs.pushEnabled;
    quietHoursActive = isWithinQuietHours(prefs.quietHours);

    // Category toggles were saved (updateVendorNotificationPreferences) but
    // never read back here — every category fired as long as pushEnabled
    // was on. Only categories with a real notification-creation call site
    // are gated; the rest of VendorNotificationPreferences (paymentConfirmed,
    // orderChanges, actionRequired, pendingOrderReminder,
    // unreadMessageReminder) has no corresponding event anywhere yet, so
    // there is nothing yet to gate for those.
    if (notification.domain === "vendor_chat") {
      pushEnabled = pushEnabled && prefs.newMessage;
    }

    // Security alerts always bypass — never disableable
    if (notification.domain === "system" && notification.type === "security_alert") {
      pushEnabled = true;
      quietHoursActive = false;
    }
  } else if (recipientRole === "customer") {
    const prefSnap = await db.collection("users").doc(recipientUid)
      .collection("settings").doc("notifications").get();
    const prefs: CustomerNotificationPreferences = prefSnap.exists
      ? (prefSnap.data() as CustomerNotificationPreferences)
      : { ...CUSTOMER_NOTIFICATION_DEFAULTS, updatedAt: FieldValue.serverTimestamp() };

    pushEnabled = prefs.pushEnabled;

    // Same gap as the vendor side — only categories with a real
    // notification-creation call site are gated here. pickupReminders,
    // cartReminders and promotions have no corresponding event anywhere yet.
    if (notification.domain === "customer_chat") {
      pushEnabled = pushEnabled && prefs.chatMessages;
    } else if (notification.domain === "order") {
      pushEnabled = pushEnabled && prefs.orderUpdates;
    }
  }

  if (!pushEnabled) {
    await notifRef.update({ pushSent: false, pushError: "push_disabled_by_preference" });
    return;
  }

  // Critical notifications bypass quiet hours; non-critical are delayed
  // (delay implementation = simply not sent now; a scheduled resend job
  // is out of MVP scope per the client's "keep it lightweight" instruction —
  // documented as a known limitation).
  if (quietHoursActive && !notification.isCritical) {
    await notifRef.update({ pushSent: false, pushError: "deferred_quiet_hours" });
    return;
  }

  const tokensSnap = await db.collection("users").doc(recipientUid)
    .collection("pushTokens")
    .where("enabled", "==", true)
    .get();

  if (tokensSnap.empty) {
    await notifRef.update({ pushSent: false, pushError: "no_active_tokens" });
    return;
  }

  const tokens = tokensSnap.docs.map((d) => d.data() as PushTokenDoc);
  let anySucceeded = false;
  const invalidTokenIds: string[] = [];

  for (const tokenDoc of tokens) {
    try {
      const result = await sendExpoPush(
        tokenDoc.token,
        notification.title,
        notification.body,
        { deepLink: notification.deepLink ?? "", notificationId: notificationDocId }
      );
      if (result.ok) {
        anySucceeded = true;
      } else {
        // One device failing must not fail the whole notification.
        if (result.deviceNotRegistered) invalidTokenIds.push(tokenDoc.tokenId);
        logger.warn(`Push send failed for token ${tokenDoc.tokenId}: ${result.message}`);
      }
    } catch (err: any) {
      logger.warn(`Push send failed for token ${tokenDoc.tokenId}: ${err?.message}`);
    }
  }

  if (invalidTokenIds.length > 0) {
    const batch = db.batch();
    for (const tokenId of invalidTokenIds) {
      batch.delete(db.collection("users").doc(recipientUid).collection("pushTokens").doc(tokenId));
    }
    await batch.commit().catch(() => null);
  }

  await notifRef.update({
    pushSent: anySucceeded,
    pushSentAt: anySucceeded ? FieldValue.serverTimestamp() : null,
    pushError: anySucceeded ? null : "all_tokens_failed",
  });
}

function isWithinQuietHours(quietHours?: { enabled: boolean; startHour?: number; endHour?: number }): boolean {
  if (!quietHours?.enabled || quietHours.startHour == null || quietHours.endHour == null) return false;
  const hour = new Date().getUTCHours(); // MVP: UTC-based; timezone-aware scheduling is a later-phase improvement
  const { startHour, endHour } = quietHours;
  if (startHour <= endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour; // wraps midnight
}

// ─── markNotificationRead (client-callable, narrow allowlist) ────────────────

export const markNotificationRead = https.onCall(async (request) => {
  checkAppCheck(request, "markNotificationRead");
  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");

  const uid = request.auth.uid;
  const { notificationId } = request.data ?? {};
  if (!notificationId) throw new https.HttpsError("invalid-argument", "notificationId is required.");

  const notifRef = db.collection("users").doc(uid).collection("notifications").doc(notificationId);
  const snap = await notifRef.get();
  if (!snap.exists) throw new https.HttpsError("not-found", "Notification not found.");

  await notifRef.update({ read: true, readAt: FieldValue.serverTimestamp() });
  return { success: true };
});

// ─── registerPushToken ────────────────────────────────────────────────────────

export const registerPushToken = https.onCall(async (request) => {
  await enforceRateLimit(
    request.auth?.uid ?? `ip:${request.rawRequest?.ip ?? "unknown"}`,
    "registerPushToken",
    10,
  );
  const requestId = newRequestId();
  checkAppCheck(request, "registerPushToken");
  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");

  const uid = request.auth.uid;
  const { token, platform, deviceId, appVersion } = request.data ?? {};

  if (!token) throw new https.HttpsError("invalid-argument", "token is required.");
  if (!["ios", "android", "web"].includes(platform)) {
    throw new https.HttpsError("invalid-argument", "platform must be ios, android, or web.");
  }

  const now = FieldValue.serverTimestamp();
  // Deterministic-ish: use the token itself hashed would be ideal, but for
  // MVP simplicity we key on a stable doc id per device if provided,
  // else auto-id (duplicate tokens across auto-ids are harmless — push
  // dispatch dedupes are not required at this scale).
  const tokenRef = deviceId
    ? db.collection("users").doc(uid).collection("pushTokens").doc(deviceId)
    : db.collection("users").doc(uid).collection("pushTokens").doc();

  const tokenDoc: PushTokenDoc = {
    tokenId: tokenRef.id,
    token,
    platform,
    deviceId: deviceId ?? null,
    appVersion: appVersion ?? null,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };

  await tokenRef.set(tokenDoc, { merge: true });
  return { success: true, tokenId: tokenRef.id };
});
