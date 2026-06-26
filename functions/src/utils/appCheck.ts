import { https, logger } from "firebase-functions/v2";
import { AppCheckContext } from "../types";

/**
 * App Check helper (P1-FB-008).
 *
 * Firebase Functions v2 callables automatically populate
 * `request.app` with the verified App Check token claims when the client
 * sends a valid token, or leave it `undefined` if missing/invalid
 * (depending on `enforceAppCheck` at function definition time).
 *
 * Strategy:
 *  - MONITOR MODE (default, controlled by APP_CHECK_ENFORCE env var):
 *    Functions are defined WITHOUT `enforceAppCheck: true`. We inspect
 *    `request.app` ourselves, log/record whether App Check was present and
 *    valid, but do NOT block the request. This lets the client roll out App
 *    Check on the frontend first and watch real traffic before enforcing.
 *
 *  - ENFORCEMENT MODE (APP_CHECK_ENFORCE=true):
 *    Requests without a valid App Check token are rejected with
 *    'failed-precondition'. Intended for production once mobile/web App
 *    Check providers are confirmed registered (see deployment-guide.md).
 *
 * Every callable that uses this helper records the resulting
 * AppCheckContext into its audit log entry via writeAuditLog.
 */

const ENFORCE = process.env.APP_CHECK_ENFORCE === "true";

export function getAppCheckContext(request: https.CallableRequest<unknown>): AppCheckContext {
  const present = request.app !== undefined;
  // request.app is only populated if the token was present AND valid.
  const verified = present ? true : ENFORCE ? false : null;
  return { present, verified };
}

/**
 * Call at the top of any sensitive callable. In enforcement mode, throws if
 * App Check is missing/invalid. In monitor mode, only logs.
 */
export function checkAppCheck(
  request: https.CallableRequest<unknown>,
  functionName: string
): AppCheckContext {
  const ctx = getAppCheckContext(request);

  if (!ctx.present) {
    logger.warn(`[AppCheck] Missing/invalid App Check token on ${functionName}`, {
      functionName,
      enforceMode: ENFORCE,
    });

    if (ENFORCE) {
      throw new https.HttpsError(
        "failed-precondition",
        "App Check verification failed. Please update the app and try again."
      );
    }
  }

  return ctx;
}
