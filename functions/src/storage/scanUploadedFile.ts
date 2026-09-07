import { onObjectFinalized } from "firebase-functions/v2/storage";
import { GoogleAuth } from "google-auth-library";
import { admin, db, FieldValue } from "../admin";
import { logOperationalEvent } from "../utils/operationalLogging";

/**
 * Malware scanning on user uploads — paid work, bundled into the same
 * payment as the frontend Phase fixes (billing record, 2026-08-21).
 *
 * Fires on every new object in the default bucket; only user-supplied
 * content prefixes are actually sent for scanning. Everything the backend
 * itself generates (invoice/receipt PDFs) is skipped — it never came from
 * an untrusted client, so scanning it would only add cost and latency.
 *
 * Scanning runs against a private Cloud Run service running ClamAV
 * (services/malware-scanner/), called with this function's own identity
 * token — Cloud Run's IAM invoker check does the authentication, no shared
 * secret needed. MALWARE_SCANNER_URL must be set on the deployed
 * environment once that service exists; see services/malware-scanner for
 * the deploy steps.
 */
const SCANNED_PREFIXES = [
  "paymentProofs/",
  "verificationDocuments/",
  "vendorMedia/",
  "invoiceBranding/",
  "users/",
];

let cachedAuth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  if (!cachedAuth) cachedAuth = new GoogleAuth();
  return cachedAuth;
}

interface ScanResult {
  clean: boolean;
  threat?: string;
}

async function callScanner(scannerUrl: string, bucket: string, name: string): Promise<ScanResult> {
  const client = await getAuth().getIdTokenClient(scannerUrl);
  const resp = await client.request<ScanResult>({
    url: `${scannerUrl}/scan`,
    method: "POST",
    data: { bucket, name },
    timeout: 60000,
  });
  return resp.data;
}

export const scanUploadedFile = onObjectFinalized(
  {
    // onObjectFinalized resolves the default bucket from FIREBASE_CONFIG at
    // module-load time when no bucket is given; that env var only exists
    // inside the real deployed runtime, not during the CLI's local
    // introspection pass before deploy, which crashed the whole codebase
    // load (surfaced as a generic "Cannot determine backend specification"
    // timeout) until this was made explicit.
    bucket: "laetiva-dev.firebasestorage.app",
    // Storage triggers must run in the same region as the bucket itself
    // (an Eventarc requirement) — the default bucket here is us-east1, not
    // us-central1 like the rest of this codebase's callables. The Cloud Run
    // scanner stays in us-central1; cross-region HTTP calls to it are fine,
    // only the trigger's own region is constrained.
    region: "us-east1",
    memory: "256MiB",
    timeoutSeconds: 90,
  },
  async (event) => {
    const { bucket, name, contentType } = event.data;
    if (!name || !SCANNED_PREFIXES.some((prefix) => name.startsWith(prefix))) return;

    const scannerUrl = process.env.MALWARE_SCANNER_URL;
    if (!scannerUrl) {
      logOperationalEvent({
        functionName: "scanUploadedFile",
        event: "scanner_not_configured",
        severity: "CRITICAL",
        metadata: { bucket, name },
      });
      return;
    }

    let result: ScanResult;
    try {
      result = await callScanner(scannerUrl, bucket, name);
    } catch (err) {
      // Fail open, not closed: a scanner outage must never delete a
      // genuine upload someone is relying on (a payment proof, a
      // verification document). Logged CRITICAL and recorded for manual
      // review instead — an infra outage should page someone, not
      // silently destroy user data.
      logOperationalEvent({
        functionName: "scanUploadedFile",
        event: "scan_call_failed",
        severity: "CRITICAL",
        metadata: { bucket, name, errorMessage: err instanceof Error ? err.message : String(err) },
      });
      await db.collection("malwareScanEvents").add({
        bucket,
        name,
        contentType: contentType ?? null,
        status: "scan_failed",
        createdAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    if (!result.clean) {
      await admin.storage().bucket(bucket).file(name).delete({ ignoreNotFound: true });
      await db.collection("malwareScanEvents").add({
        bucket,
        name,
        contentType: contentType ?? null,
        status: "infected",
        threat: result.threat ?? "unknown",
        createdAt: FieldValue.serverTimestamp(),
      });
      logOperationalEvent({
        functionName: "scanUploadedFile",
        event: "malware_detected_and_deleted",
        severity: "CRITICAL",
        metadata: { bucket, name, threat: result.threat },
      });
    }
  }
);
