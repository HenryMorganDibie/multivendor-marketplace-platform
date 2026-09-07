import { onSchedule } from "firebase-functions/v2/scheduler";
import { https, logger } from "firebase-functions/v2";
import { db, auth } from "../admin";
import { writeAuditLog } from "../utils/auditLog";
import { assertAdmin } from "../utils/adminAuth";
import { newRequestId } from "../utils/requestContext";

/**
 * Orphaned authentication users.
 *
 * Registration spans several writes: the auth user, the users document, claims,
 * then the vendor record. A failure part-way leaves an auth user that can never
 * sign in usefully, and its email is occupied forever — nobody, including the
 * person who owns that address, can register with it again.
 *
 * The client deletes the auth user when it can, but that runs on the device
 * that just failed. A dropped connection, a killed app or an expired token and
 * the cleanup never happens. It cannot be the only recovery path.
 *
 * Two mechanisms here, and a third elsewhere:
 *
 *   1. completeRegistration is resumable, so a user who comes back finishes
 *      rather than being told the account is already finalized. That is the
 *      preferred outcome: the person keeps their account.
 *   2. This scheduled sweep removes the ones that never came back.
 *   3. cleanupOrphanedAccount below lets an admin resolve a specific address
 *      immediately, rather than waiting for the next sweep.
 */

/** How long an unfinished account is left alone before the sweep removes it. */
const ORPHAN_GRACE_HOURS = 24;

/**
 * The window the manual admin path respects.
 *
 * Deliberately much shorter than the sweep's. This function exists for someone
 * reporting "it says my email is taken but I cannot log in", and answering that
 * with "wait a day" defeats the point of having it. But it still must not delete
 * an account seconds old, because someone reading the terms right now looks
 * exactly like an abandoned registration.
 *
 * Fifteen minutes is longer than any signup takes and short enough to be useful
 * on a support call. Configurable so it can be tuned in operation without a
 * deploy, and so tests can exercise the deletion path without waiting.
 */
const MANUAL_CLEANUP_GRACE_MINUTES = Number(process.env.MANUAL_CLEANUP_GRACE_MINUTES ?? 15);

interface OrphanCandidate {
  uid: string;
  email: string | null;
  reason: "no_user_document" | "onboarding_never_completed";
}

/**
 * An account is only an orphan if it is both unfinished and old enough that
 * somebody mid-signup could not still be working through it. Someone who
 * registered ninety seconds ago and is reading the terms is not an orphan.
 */
async function findOrphans(graceHours: number, limit = 500): Promise<OrphanCandidate[]> {
  const cutoff = Date.now() - graceHours * 60 * 60 * 1000;
  const orphans: OrphanCandidate[] = [];
  let pageToken: string | undefined;

  do {
    const page = await auth.listUsers(1000, pageToken);
    pageToken = page.pageToken;

    for (const user of page.users) {
      if (orphans.length >= limit) break;

      const createdMs = Date.parse(user.metadata.creationTime);
      if (Number.isFinite(createdMs) && createdMs > cutoff) continue;

      const userDoc = await db.collection("users").doc(user.uid).get();

      // The onUserCreate trigger never ran, or failed. Nothing references this
      // account anywhere.
      if (!userDoc.exists) {
        orphans.push({ uid: user.uid, email: user.email ?? null, reason: "no_user_document" });
        continue;
      }

      const data = userDoc.data() ?? {};
      const completed = data.onboarding?.completed === true;
      const hasRole = data.role === "vendor" || data.role === "admin";

      // A customer who registered and never finished onboarding still has a
      // usable account, so only sweep the ones that never got anywhere: no
      // finalised role and no completed onboarding.
      if (!completed && !hasRole) {
        orphans.push({ uid: user.uid, email: user.email ?? null, reason: "onboarding_never_completed" });
      }
    }
  } while (pageToken && orphans.length < limit);

  return orphans;
}

/**
 * Runs daily. Deletes the auth user and any stranded users document, freeing
 * the email address.
 */
export const cleanupOrphanedAccounts = onSchedule(
  { schedule: "every 24 hours", timeZone: "UTC" },
  async () => {
    const requestId = newRequestId();
    const orphans = await findOrphans(ORPHAN_GRACE_HOURS);

    if (orphans.length === 0) {
      logger.info("Orphan sweep found nothing to clean up.");
      return;
    }

    let deleted = 0;
    for (const orphan of orphans) {
      try {
        await auth.deleteUser(orphan.uid);
        // The users document goes too, otherwise a future account with a
        // recycled uid would inherit it.
        await db.collection("users").doc(orphan.uid).delete().catch(() => undefined);
        deleted += 1;

        await writeAuditLog({
          requestId,
          functionName: "cleanupOrphanedAccounts",
          actorUid: "system",
          actorRole: "admin",
          actorType: "system",
          targetType: "user",
          targetId: orphan.uid,
          eventType: "user.orphan_cleaned",
          message: `Removed an unfinished account (${orphan.reason}), freeing its email address.`,
          appCheck: { present: false, verified: null },
        });
      } catch (err) {
        // One failure must not stop the sweep; the rest are still worth doing.
        logger.error("Could not remove orphaned account.", { uid: orphan.uid, err });
      }
    }

    logger.info(`Orphan sweep removed ${deleted} of ${orphans.length} candidates.`);
  }
);

/**
 * Admin-triggered cleanup for one address.
 *
 * Someone reporting "it says my email is taken but I cannot log in" should not
 * be told to wait a day for the sweep.
 */
export const cleanupOrphanedAccount = https.onCall(async (request) => {
  /**
   * assertAdmin rather than reading the role claim directly.
   *
   * The claim alone is not enough for something that deletes accounts. Revoking
   * an admin rewrites their custom claims but cannot revoke an ID token already
   * issued, so a revoked admin keeps `role: "admin"` in hand for up to an hour.
   * assertAdmin re-checks adminUsers/{uid}.status on every call, which is what
   * closes that window, and it is what the other admin callables use.
   *
   * Scoped to super_admin. Permanent account deletion sits alongside revoking
   * another admin, which is already super_admin only; a support or verification
   * admin has no business holding it.
   */
  const { uid: adminUid, roleIds } = await assertAdmin(request, ["super_admin"]);

  const email = (request.data?.email as string | undefined)?.trim();
  if (!email) {
    throw new https.HttpsError("invalid-argument", "email is required.");
  }

  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch {
    throw new https.HttpsError("not-found", "No account exists with that email.");
  }

  // An account seconds old is indistinguishable from an abandoned one: no
  // completed onboarding, no finalised role. Someone reading the terms right
  // now, or an invited admin who has not accepted yet, must not be deletable.
  const createdMs = Date.parse(user.metadata.creationTime);
  if (Number.isFinite(createdMs) && createdMs > Date.now() - MANUAL_CLEANUP_GRACE_MINUTES * 60 * 1000) {
    throw new https.HttpsError(
      "failed-precondition",
      `That account was created less than ${MANUAL_CLEANUP_GRACE_MINUTES} minutes ago and may still be completing registration. Try again shortly.`
    );
  }

  const userDoc = await db.collection("users").doc(user.uid).get();
  const data = userDoc.data() ?? {};
  const completed = data.onboarding?.completed === true;
  const hasRole = data.role === "vendor" || data.role === "admin";

  // Refusing to delete a working account is the important guard here. This
  // function exists to unstick people, not to remove customers.
  if (userDoc.exists && (completed || hasRole)) {
    throw new https.HttpsError(
      "failed-precondition",
      "That account completed registration and will not be deleted."
    );
  }

  await auth.deleteUser(user.uid);
  await db.collection("users").doc(user.uid).delete().catch(() => undefined);

  await writeAuditLog({
    requestId: newRequestId(),
    functionName: "cleanupOrphanedAccount",
    actorUid: adminUid,
    actorRole: "admin",
    actorType: "admin",
    targetType: "user",
    targetId: user.uid,
    eventType: "user.orphan_cleaned",
    // The specific admin roles held, so the trail says which capability was
    // used rather than only that somebody with admin rights did it.
    message: `Admin (${roleIds.join(", ") || "unknown role"}) freed the email address ${email} from an unfinished account.`,
    appCheck: { present: false, verified: null },
  });

  return { success: true, uid: user.uid, email };
});
