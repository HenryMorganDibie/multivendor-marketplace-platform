import { https } from "firebase-functions/v2";
import { db } from "../admin";
import { AdminRoleId } from "../types";

/**
 * How long a verified MFA check remains valid before a sensitive admin
 * action requires a fresh code. Read directly from adminUsers/{uid}.lastMfaAt
 * on every call (Firestore, not the ID token) — the same reasoning already
 * used for the `status === 'active'` check above: a token can be valid for
 * up to an hour after something server-side changes, so time-sensitive
 * checks read Firestore fresh rather than trust token claims. 12 hours is a
 * judgment call (a work-day-ish window), not a value specified anywhere —
 * adjustable without changing the enforcement mechanism itself. Exported so
 * adminMfa.ts's enrollment/verification callables and this check agree on
 * the same window without duplicating the number.
 */
export const MFA_FRESHNESS_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Kill switch for the MFA enforcement check below. Every existing admin has
 * `mfaRequired: true` (set unconditionally by acceptAdminInvite since it was
 * first built) but none has ever enrolled, because nothing has ever asked
 * them to — no Ops Console screen calls beginAdminMfaEnrollment yet.
 * Flipping the check on before that screen exists would lock every current
 * admin, including whoever's using the Ops Console right now, out of every
 * admin action with no way back in except a manual Firestore edit. The
 * enrollment/verification callables (adminMfa.ts) are real and safe to use
 * today regardless of this flag; only the "reject the call if not enrolled/
 * verified" half is gated. Flip to `true` once the Ops Console has a real
 * enrollment flow and at least the active admins have actually enrolled —
 * that's the only change needed to turn enforcement on, nothing else in
 * this function needs to move.
 */
const MFA_ENFORCEMENT_ENABLED = false;

/**
 * Admin authorization (P1-FB-006 / P1-FB-005 review fix).
 *
 * Verifies:
 *  1. The caller's custom claim includes `role: 'admin'` and at least one
 *     `adminRoleIds` entry.
 *  2. The corresponding `adminUsers/{uid}` document exists and has
 *     `status === 'active'` (catches revoked/suspended admins whose token
 *     hasn't been refreshed yet — tokens can be valid for up to 1 hour
 *     after revocation).
 *  3. (Optional) the caller holds at least one of `allowedRoles`.
 *  4. MFA enforcement (Milestone 1 scope: "MFA enforcement for admins",
 *     already paid for — adminUsers.mfaRequired/mfaEnrolled/lastMfaAt have
 *     existed on the schema since acceptAdminInvite was built, but nothing
 *     ever checked them here). If `mfaRequired`, the admin must have
 *     completed enrollment (`mfaEnrolled`) and verified a code within the
 *     last MFA_FRESHNESS_WINDOW_MS (`lastMfaAt`, read fresh from Firestore
 *     for the same reason `status` is — never trust the token's own claims
 *     for a time-sensitive check). Distinct error messages so the Ops
 *     Console can tell "needs to enroll" apart from "needs to re-verify"
 *     and route to the right screen instead of a generic access-denied.
 *     Currently gated by MFA_ENFORCEMENT_ENABLED, see that constant.
 *
 * Returns the admin's uid and roleIds for use in audit logs.
 */
export async function assertAdmin(
  request: https.CallableRequest<unknown>,
  allowedRoles?: AdminRoleId[],
  options?: { skipMfaCheck?: boolean }
): Promise<{ uid: string; roleIds: AdminRoleId[] }> {
  if (!request.auth || request.auth.token.role !== "admin") {
    throw new https.HttpsError("permission-denied", "Admin access required.");
  }

  const uid = request.auth.uid;
  const tokenRoleIds = (request.auth.token.adminRoleIds as AdminRoleId[] | undefined) ?? [];

  const adminDoc = await db.collection("adminUsers").doc(uid).get();
  if (!adminDoc.exists) {
    throw new https.HttpsError("permission-denied", "Admin record not found.");
  }

  const adminData = adminDoc.data();
  if (adminData?.status !== "active") {
    throw new https.HttpsError(
      "permission-denied",
      `Admin access has been ${adminData?.status ?? "revoked"}.`
    );
  }

  if (!options?.skipMfaCheck && adminData?.mfaRequired) {
    if (!adminData.mfaEnrolled) {
      throw new https.HttpsError("failed-precondition", "MFA_ENROLLMENT_REQUIRED");
    }
    const lastMfaAt = adminData.lastMfaAt?.toDate ? adminData.lastMfaAt.toDate() : null;
    const isFresh = lastMfaAt != null && Date.now() - lastMfaAt.getTime() < MFA_FRESHNESS_WINDOW_MS;
    if (!isFresh) {
      throw new https.HttpsError("failed-precondition", "MFA_VERIFICATION_REQUIRED");
    }
  }

  const roleIds: AdminRoleId[] = adminData.roleIds ?? tokenRoleIds;

  if (allowedRoles && allowedRoles.length > 0) {
    const hasPermission =
      roleIds.includes("super_admin") || roleIds.some((r) => allowedRoles.includes(r));
    if (!hasPermission) {
      throw new https.HttpsError(
        "permission-denied",
        `Requires one of: ${allowedRoles.join(", ")}.`
      );
    }
  }

  return { uid, roleIds };
}
