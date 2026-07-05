import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { ModerationRuleDoc } from "../types3";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { assertAdmin } from "../utils/adminAuth";
import { DEFAULT_MODERATION_RULES, ruleIdFor } from "./moderationSeedData";
import { clearModerationRuleCache } from "./moderationEngine";

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
  clearModerationRuleCache();

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
