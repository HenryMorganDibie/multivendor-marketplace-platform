import { randomUUID } from "crypto";

/**
 * Generates a per-invocation request ID for audit log correlation
 * (P1-FB-009 requirement: requestId + functionName on every audit entry).
 */
export function newRequestId(): string {
  return randomUUID();
}
