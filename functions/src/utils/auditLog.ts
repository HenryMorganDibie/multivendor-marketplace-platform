import { db, FieldValue } from "../admin";
import {
  AdminRoleId,
  AppCheckContext,
  AuditActorType,
  AuditLogDoc,
  UserRole,
} from "../types";

interface WriteAuditLogParams {
  requestId: string;
  functionName: string;

  actorUid: string | null;
  actorRole: UserRole | "system";
  actorType: AuditActorType;
  actorAdminRoleIds?: AdminRoleId[];

  targetType: string;
  targetId: string;

  eventType: string;
  message?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;

  appCheck: AppCheckContext;
}

const ENVIRONMENT = process.env.GCLOUD_PROJECT ?? "unknown";

/**
 * Writes an immutable audit log entry (P1-FB-009, full schema).
 *
 * Includes requestId, functionName, and App Check status per Phase 1
 * acceptance criteria. auditLogs is write-only from Cloud Functions and
 * never client-writable (enforced in firestore.rules).
 *
 * PII note: callers should pass `before`/`after` snapshots containing only
 * the fields relevant to the event, not full raw documents, to avoid
 * over-logging PII (see onUserDelete for the redaction pattern).
 */
export async function writeAuditLog(params: WriteAuditLogParams): Promise<void> {
  const entry: AuditLogDoc = {
    requestId: params.requestId,
    functionName: params.functionName,
    actor: {
      uid: params.actorUid,
      role: params.actorRole,
      type: params.actorType,
      adminRoleIds: params.actorAdminRoleIds,
    },
    target: {
      type: params.targetType,
      id: params.targetId,
    },
    eventType: params.eventType,
    message: params.message,
    before: params.before ?? null,
    after: params.after ?? null,
    metadata: params.metadata ?? {},
    appCheck: params.appCheck,
    environment: ENVIRONMENT,
    createdAt: FieldValue.serverTimestamp(),
  };

  await db.collection("auditLogs").add(entry);
}
