import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { ModerationRuleDoc } from "../types3";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { assertAdmin } from "../utils/adminAuth";
import { DEFAULT_MODERATION_RULES, ruleIdFor } from "./moderationSeedData";

/**
 * seedDefaultModerationRules (P3-FB-021).
 *
 * Bootstraps moderationRules with the default rule set. Idempotent: ruleIds
 * are deterministic (category + pattern slug), so re-running this upserts
 * rather than duplicates, the same discipline already used for support
 * ticket / chat thread IDs elsewhere in Phase 3. This exists because the
 * rules are backend-managed Firestore config, not a hardcoded list in the
 * moderation engine — something has to put the starting set there, and
 * full admin CRUD tooling for editing individual rules is Phase 5 scope.
 */
export const seedDefaultModerationRules = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "seedDefaultModerationRules");

  const admin = await assertAdmin(request, ["super_admin"]);

  const now = FieldValue.serverTimestamp();
  const batch = db.batch();
  let count = 0;

  for (const seed of DEFAULT_MODERATION_RULES) {
    const ruleId = ruleIdFor(seed);
    const ruleRef = db.collection("moderationRules").doc(ruleId);
    const rule: ModerationRuleDoc = {
      ruleId,
      category: seed.category,
      pattern: seed.pattern,
      isRegex: seed.isRegex ?? false,
      standalone: seed.standalone ?? true,
      severity: seed.severity,
      action: seed.action,
      appliesTo: seed.appliesTo,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    batch.set(ruleRef, rule, { merge: true });
    count++;
  }

  await batch.commit();

  await writeAuditLog({
    requestId,
    functionName: "seedDefaultModerationRules",
    actorUid: admin.uid,
    actorRole: "admin",
    actorType: "admin",
    targetType: "moderationRules",
    targetId: "default_seed",
    eventType: "moderation.rules_seeded",
    metadata: { ruleCount: count },
    appCheck,
  });

  return { success: true, ruleCount: count };
});

/**
 * reviewModerationRestriction (P3-FB-021).
 *
 * A cumulative moderation score crossing 50/100 auto-escalates a user's
 * accountStatus to "frozen"/"banned" (moderationEngine.applyUserModerationScore).
 * That escalation never reverses itself — this is the one path back,
 * restricted to safety_admin/super_admin, mirroring the "pending review"
 * language in the moderation spec: someone has to actually look at the
 * account before access is restored. Resets the score to 0 rather than
 * leaving it just under the threshold, since the account is being treated
 * as a clean slate after human review, not merely nudged back from the edge.
 */
export const reviewModerationRestriction = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "reviewModerationRestriction");

  const admin = await assertAdmin(request, ["super_admin", "safety_admin"]);

  const { uid, decision } = request.data ?? {};
  if (!uid) throw new https.HttpsError("invalid-argument", "uid is required.");
  if (decision !== "clear" && decision !== "confirm_ban") {
    throw new https.HttpsError("invalid-argument", "decision must be 'clear' or 'confirm_ban'.");
  }

  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new https.HttpsError("not-found", "User not found.");

  const before = userSnap.data()?.accountStatus;
  const now = FieldValue.serverTimestamp();

  if (decision === "clear") {
    await userRef.update({
      accountStatus: "active",
      moderationScore: 0,
      moderationStatusReason: null,
      moderationWarnedAt: null,
      moderationRestrictedAt: null,
      moderationBannedAt: null,
      updatedAt: now,
    });
  } else {
    await userRef.update({
      accountStatus: "banned",
      moderationStatusReason: `Confirmed by admin review (requestId ${requestId}).`,
      moderationBannedAt: now,
      updatedAt: now,
    });
  }

  await writeAuditLog({
    requestId,
    functionName: "reviewModerationRestriction",
    actorUid: admin.uid,
    actorRole: "admin",
    actorType: "admin",
    targetType: "user",
    targetId: uid,
    eventType: "moderation.restriction_reviewed",
    before: { accountStatus: before },
    after: { accountStatus: decision === "clear" ? "active" : "banned", decision },
    appCheck,
  });

  return { success: true };
});
