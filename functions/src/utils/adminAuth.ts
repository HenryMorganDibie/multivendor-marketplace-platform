import { https } from "firebase-functions/v2";
import { db } from "../admin";
import { AdminRoleId } from "../types";

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
 *
 * Returns the admin's uid and roleIds for use in audit logs.
 */
export async function assertAdmin(
  request: https.CallableRequest<unknown>,
  allowedRoles?: AdminRoleId[]
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
