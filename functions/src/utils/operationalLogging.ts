import { logger } from "firebase-functions/v2";

/**
 * Structured operational logging (P3-FB-019).
 *
 * This is deliberately separate from writeAuditLog in utils/auditLog.ts.
 * The audit log is a durable, queryable business record of who did what,
 * stored in Firestore, and is the correct source for compliance and
 * dispute review. This module is for operational signals, elevated error
 * rates, slow execution, abuse patterns, that need to reach Cloud
 * Logging in a structured, severity-tagged format so Cloud Monitoring
 * log-based alerting policies can filter and page on them in real time.
 * Writing operational alerts as Firestore documents would mean nobody
 * sees them during an actual incident unless they happen to be looking.
 *
 * This module does not create Cloud Monitoring alerting policies itself.
 * Alerting policies are Google Cloud console configuration, not
 * application code, and must be created by whoever holds console access
 * to the Firebase/GCP project. What this module provides is the
 * structured, filterable log output those policies would match against.
 * See the ALERT CONDITIONS block at the bottom of this file for the
 * exact filters to configure.
 */

interface OperationalLogParams {
  functionName: string;
  event: string;
  severity: "WARNING" | "ERROR" | "CRITICAL";
  metadata?: Record<string, unknown>;
}

/**
 * logOperationalEvent — call this for conditions that represent a
 * potential operational problem rather than routine business activity:
 * a function call that failed unexpectedly, a rate limit being hit
 * repeatedly by the same actor, a transaction that had to retry due to
 * contention, or a downstream dependency (Storage, Auth, an external
 * push provider) returning an error.
 *
 * Every entry is tagged with `component: "the platform-backend"` and the
 * calling function's name, which is the minimum structure a Cloud
 * Monitoring log-based metric needs to filter on this application's
 * output specifically, distinct from Firebase's own platform logs.
 */
export function logOperationalEvent(params: OperationalLogParams): void {
  const payload = {
    component: "the platform-backend",
    functionName: params.functionName,
    event: params.event,
    ...params.metadata,
  };

  switch (params.severity) {
    case "CRITICAL":
      logger.error(payload);
      break;
    case "ERROR":
      logger.error(payload);
      break;
    case "WARNING":
    default:
      logger.warn(payload);
      break;
  }
}

/**
 * withOperationalLogging — wraps an async operation, logging duration and
 * outcome. Use this around any Cloud Function body where execution time
 * matters (transaction-heavy functions, functions calling external
 * services) so slow executions become visible in structured logs without
 * every function needing to hand-roll its own timing code.
 */
export async function withOperationalLogging<T>(
  functionName: string,
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    const durationMs = Date.now() - startedAt;
    if (durationMs > 5000) {
      logOperationalEvent({
        functionName,
        event: "slow_execution",
        severity: "WARNING",
        metadata: { durationMs },
      });
    }
    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    logOperationalEvent({
      functionName,
      event: "unhandled_error",
      severity: "ERROR",
      metadata: {
        durationMs,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

/**
 * ALERT CONDITIONS — configure these as Cloud Monitoring log-based
 * alerting policies in the Google Cloud console under Monitoring >
 * Alerting, using the Logs Explorer filter syntax shown. This is
 * documentation for manual console setup, not code this repository can
 * provision on its own, since alerting policies are project-level
 * infrastructure configuration outside a Cloud Functions deployment.
 *
 * 1. Elevated error rate
 *    Filter: resource.type="cloud_function" AND jsonPayload.component="the platform-backend" AND severity="ERROR"
 *    Condition: count > 10 within 5 minutes
 *    Rationale: a burst of unhandled errors across any function usually
 *    indicates a bad deploy, a Firestore outage, or a downstream
 *    dependency failure, and should page whoever owns production.
 *
 * 2. Repeated slow execution on a single function
 *    Filter: jsonPayload.component="the platform-backend" AND jsonPayload.event="slow_execution"
 *    Condition: count > 5 within 10 minutes, grouped by jsonPayload.functionName
 *    Rationale: isolates a specific function degrading rather than a
 *    general platform issue, which usually points at an unindexed query
 *    or a transaction contention hotspot in that function specifically.
 *
 * 3. Payment proof abuse lock triggered repeatedly
 *    Filter: jsonPayload.component="the platform-backend" AND jsonPayload.event="PAYMENT_PROOF_LIMIT_REACHED"
 *    Condition: count > 20 within 1 hour, project-wide
 *    Rationale: a spike here across many distinct orders, rather than
 *    isolated to one customer, may indicate a coordinated abuse attempt
 *    rather than ordinary customer confusion during checkout.
 *
 * 4. App Check monitor-mode rejection rate
 *    Filter: jsonPayload.message="[AppCheck] Missing/invalid App Check token"
 *    Condition: ratio of App Check failures to total requests exceeds a
 *    threshold you set once real mobile traffic is flowing, as the
 *    concrete signal for when it is safe to flip APP_CHECK_ENFORCE to true.
 */
