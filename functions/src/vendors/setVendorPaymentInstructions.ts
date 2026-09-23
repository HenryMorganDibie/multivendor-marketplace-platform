import { createHash } from "crypto";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { maskPaymentIdentifier } from "../paymentInstructions/maskPaymentIdentifier";
import { resolveVendorCountryCode, resolveVendorCurrency } from "./vendorCurrency";
import { AppCheckContext } from "../types";
import {
  BankAccountIdentifier,
  BankTransferDestination,
  ContactIdentifier,
  ContactTransferDestination,
  PaymentDestination,
  PaymentInstructionChangeEvent,
  PaymentInstructionsCurrentDoc,
  RoutingCode,
  RoutingCodeType,
} from "../types5";

const MAX_NAME_LENGTH = 100;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_IDENTIFIER_VALUE_LENGTH = 64; // storage/abuse-prevention ceiling only -- not a financial-format claim
const MAX_EMAIL_LENGTH = 254; // RFC 5321 mailbox maximum
const MAX_IBAN_LENGTH = 34; // ISO 13616's own true maximum -- specific to this field, not borrowed as a generic bound
const MAX_SWIFT_BIC_LENGTH = 11; // ISO 9362's own true maximum (8 or 11 chars) -- ceiling only, not a claim the value is a well-formed BIC
const MAX_ROUTING_ENTRIES = 3;
const VALID_ROUTING_TYPES: RoutingCodeType[] = [
  "sort_code", "routing_number", "transit_number", "institution_number", "bsb", "ifsc", "swift_bic",
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // same regex already used by auth/emailOtp.ts, for consistency
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;

// ─── Storage-safety validation (never a financial-account-format claim) ────

/**
 * Proves a string is safe to store and display -- required/non-empty,
 * bounded, no control characters. Proves nothing about whether the value
 * is a real account number, routing code, or belongs to anyone. Financial-
 * account format validation (per-country structure, checksums) is a
 * separate, not-yet-built layer -- see the module doc comment below.
 */
export function validateStorageSafeValue(raw: unknown, fieldLabel: string, maxLength = MAX_IDENTIFIER_VALUE_LENGTH): string {
  const trimmed = String(raw ?? "").trim(); // outer whitespace only -- never guess/correct meaningful content
  if (!trimmed) {
    throw new https.HttpsError("invalid-argument", `${fieldLabel} is required.`);
  }
  if (trimmed.length > maxLength) {
    throw new https.HttpsError("invalid-argument", `${fieldLabel} must be ${maxLength} characters or fewer.`);
  }
  if (CONTROL_CHAR_RE.test(trimmed)) {
    throw new https.HttpsError("invalid-argument", `${fieldLabel} contains characters that cannot be stored.`);
  }
  return trimmed;
}

function validateBoundedName(raw: unknown, fieldLabel: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    throw new https.HttpsError("invalid-argument", `${fieldLabel} is required.`);
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new https.HttpsError("invalid-argument", `${fieldLabel} must be ${MAX_NAME_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

// ─── Per-identifier-type validation ─────────────────────────────────────────

export function validateEmailIdentifierValue(raw: unknown): string {
  const trimmed = String(raw ?? "").trim().toLowerCase();
  if (!trimmed || !EMAIL_RE.test(trimmed) || trimmed.length > MAX_EMAIL_LENGTH) {
    throw new https.HttpsError("invalid-argument", "Enter a valid email address.");
  }
  return trimmed;
}

/**
 * IBAN is a bank-account identifier, not a routing code -- it replaces the
 * account number rather than supplementing it. Normalization is
 * conservative and standards-based (IBANs are internationally defined to
 * be uppercase, without internal spaces, so removing visual spaces and
 * uppercasing is semantically safe here, unlike guessing at an arbitrary
 * account number's formatting). No mod-97 checksum, no per-country length
 * table, no claim of account ownership or bank verification -- deferred
 * until backed by an actual validator (none exists in this repository; no
 * dependency has been added for this).
 */
export function validateAndNormalizeIban(raw: unknown): string {
  const noSpaces = String(raw ?? "").replace(/ /g, "");
  const normalized = noSpaces.trim().toUpperCase();
  if (!normalized) {
    throw new https.HttpsError("invalid-argument", "IBAN is required.");
  }
  if (normalized.length > MAX_IBAN_LENGTH) {
    throw new https.HttpsError("invalid-argument", `IBAN must be ${MAX_IBAN_LENGTH} characters or fewer.`);
  }
  if (CONTROL_CHAR_RE.test(normalized)) {
    throw new https.HttpsError("invalid-argument", "IBAN contains characters that cannot be stored.");
  }
  return normalized;
}

/** Same standards-based conservative normalization as IBAN -- SWIFT/BIC codes are conventionally uppercase, no internal spaces. */
export function validateAndNormalizeSwiftBic(raw: unknown): string {
  const noSpaces = String(raw ?? "").replace(/ /g, "");
  const normalized = noSpaces.trim().toUpperCase();
  return validateStorageSafeValue(normalized, "SWIFT/BIC", MAX_SWIFT_BIC_LENGTH);
}

/**
 * Uses the vendor's own server-resolved country as parsing context for a
 * national-format number; a number already in international (+) form is
 * self-describing and is parsed without forcing a default region, so a
 * vendor entering a number for a different country is never silently
 * reinterpreted. Stores E.164. No homemade dial-code concatenation, no
 * Nigeria-specific fallback -- see the module doc comment below for why
 * this does not reuse auth/phoneOtp.ts's normalizePhone(). A successful
 * parse means valid phone-number FORMAT only, never ownership or
 * reachability verification.
 */
export function validateAndNormalizePhoneIdentifier(raw: unknown, vendorCountryCode: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    throw new https.HttpsError("invalid-argument", "Phone number is required.");
  }

  const defaultRegion = trimmed.startsWith("+") ? undefined : (vendorCountryCode as CountryCode);
  const parsed = parsePhoneNumberFromString(trimmed, defaultRegion);
  if (!parsed || !parsed.isValid()) {
    throw new https.HttpsError(
      "invalid-argument",
      defaultRegion
        ? "Enter a valid phone number, or include the country code (e.g. +...)."
        : "Enter a valid phone number in international format."
    );
  }
  return parsed.number;
}

function validateRoutingCodes(raw: unknown): RoutingCode[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new https.HttpsError("invalid-argument", "routing must be an array.");
  }
  if (raw.length > MAX_ROUTING_ENTRIES) {
    throw new https.HttpsError("invalid-argument", `routing must have at most ${MAX_ROUTING_ENTRIES} entries.`);
  }
  const seenTypes = new Set<string>();
  const codes: RoutingCode[] = raw.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new https.HttpsError("invalid-argument", "Each routing entry must be an object.");
    }
    const type = (entry as Record<string, unknown>).type;
    if (typeof type !== "string" || !VALID_ROUTING_TYPES.includes(type as RoutingCodeType)) {
      throw new https.HttpsError("invalid-argument", `routing type must be one of: ${VALID_ROUTING_TYPES.join(", ")}.`);
    }
    if (seenTypes.has(type)) {
      throw new https.HttpsError("invalid-argument", `routing contains a duplicate type: "${type}".`);
    }
    seenTypes.add(type);
    const value = validateStorageSafeValue((entry as Record<string, unknown>).value, `routing "${type}" value`);
    return { type: type as RoutingCodeType, value };
  });
  return codes;
}

function validateBankAccountIdentifier(raw: unknown): BankAccountIdentifier {
  if (typeof raw !== "object" || raw === null) {
    throw new https.HttpsError("invalid-argument", "identifier must be an object.");
  }
  const rawIdentifier = raw as Record<string, unknown>;
  const type = rawIdentifier.type;

  if (type === "account_number") {
    const value = validateStorageSafeValue(rawIdentifier.value, "Account number");
    const routing = validateRoutingCodes(rawIdentifier.routing);
    return routing ? { type: "account_number", value, routing } : { type: "account_number", value };
  }
  if (type === "iban") {
    const value = validateAndNormalizeIban(rawIdentifier.value);
    // The IBAN variant carries its own dedicated swiftBic field -- never
    // duplicated into a routing array, so a swift_bic value is never
    // stored in two places for the same destination.
    if ("routing" in rawIdentifier) {
      throw new https.HttpsError("invalid-argument", "routing is not accepted alongside an IBAN identifier -- use swiftBic instead.");
    }
    const rawSwiftBic = rawIdentifier.swiftBic;
    if (rawSwiftBic === undefined || rawSwiftBic === null) {
      return { type: "iban", value };
    }
    return { type: "iban", value, swiftBic: validateAndNormalizeSwiftBic(rawSwiftBic) };
  }
  throw new https.HttpsError(
    "invalid-argument",
    `Bank Transfer identifier type must be "account_number" or "iban" -- email/phone identifiers are not accepted inside bank_transfer.`
  );
}

function validateContactIdentifier(raw: unknown, vendorCountryCode: string): ContactIdentifier {
  if (typeof raw !== "object" || raw === null) {
    throw new https.HttpsError("invalid-argument", "identifier must be an object.");
  }
  const rawIdentifier = raw as Record<string, unknown>;
  const type = rawIdentifier.type;

  if (type === "email") {
    return { type: "email", value: validateEmailIdentifierValue(rawIdentifier.value) };
  }
  if (type === "phone") {
    return { type: "phone", value: validateAndNormalizePhoneIdentifier(rawIdentifier.value, vendorCountryCode) };
  }
  throw new https.HttpsError(
    "invalid-argument",
    `Contact Transfer identifier type must be "email" or "phone" -- account number/IBAN identifiers are not accepted inside contact_transfer.`
  );
}

/**
 * Validates the client's raw destination input and stamps it with the
 * server-derived country/currency -- countryCode/currencyCode are never
 * accepted from the client, on either destination variant.
 */
export function validatePaymentDestinationInput(
  raw: unknown,
  vendorCountryCode: string,
  currencyCode: string
): PaymentDestination | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") {
    throw new https.HttpsError("invalid-argument", "paymentDestination must be an object or null.");
  }
  const rawDestination = raw as Record<string, unknown>;
  if ("countryCode" in rawDestination || "currencyCode" in rawDestination) {
    throw new https.HttpsError("invalid-argument", "countryCode/currencyCode are server-derived and must not be supplied.");
  }

  if (rawDestination.type === "bank_transfer") {
    const institutionName = validateBoundedName(rawDestination.institutionName, "Institution name");
    const recipientName = validateBoundedName(rawDestination.recipientName, "Recipient name");
    const identifier = validateBankAccountIdentifier(rawDestination.identifier);
    const destination: BankTransferDestination = {
      type: "bank_transfer",
      countryCode: vendorCountryCode,
      currencyCode,
      institutionName,
      recipientName,
      identifier,
    };
    return destination;
  }

  if (rawDestination.type === "contact_transfer") {
    if ("institutionName" in rawDestination) {
      throw new https.HttpsError("invalid-argument", "institutionName is not accepted for contact_transfer -- a bank institution does not apply.");
    }
    const recipientName = validateBoundedName(rawDestination.recipientName, "Recipient name");
    const identifier = validateContactIdentifier(rawDestination.identifier, vendorCountryCode);
    const destination: ContactTransferDestination = {
      type: "contact_transfer",
      countryCode: vendorCountryCode,
      currencyCode,
      recipientName,
      identifier,
    };
    return destination;
  }

  throw new https.HttpsError("invalid-argument", `paymentDestination.type must be "bank_transfer" or "contact_transfer".`);
}

// ─── Canonicalization (stable key order for equality + hashing) ────────────

interface CanonicalRoutingCode { type: RoutingCodeType; value: string }
interface CanonicalBankAccountIdentifier {
  type: "account_number" | "iban";
  value: string;
  routing?: CanonicalRoutingCode[];
  swiftBic?: string | null;
}
interface CanonicalContactIdentifier { type: "email" | "phone"; value: string }
interface CanonicalDestination {
  type: "bank_transfer" | "contact_transfer";
  countryCode: string;
  currencyCode: string;
  institutionName?: string;
  recipientName: string;
  identifier: CanonicalBankAccountIdentifier | CanonicalContactIdentifier;
}
interface CanonicalPayload {
  acceptCash: boolean;
  paymentDestination: CanonicalDestination | null;
}

function buildCanonicalRouting(routing: RoutingCode[] | undefined): CanonicalRoutingCode[] {
  // Sorted by type so two submissions of the same routing codes in a
  // different order hash identically -- no spurious version bump from
  // client-side array-ordering differences.
  return (routing ?? [])
    .slice()
    .sort((a, b) => a.type.localeCompare(b.type))
    .map((r) => ({ type: r.type, value: r.value }));
}

function buildCanonicalBankAccountIdentifier(identifier: BankAccountIdentifier): CanonicalBankAccountIdentifier {
  if (identifier.type === "account_number") {
    return { type: "account_number", value: identifier.value, routing: buildCanonicalRouting(identifier.routing) };
  }
  return { type: "iban", value: identifier.value, swiftBic: identifier.swiftBic ?? null };
}

function buildCanonicalDestination(destination: PaymentDestination | null): CanonicalDestination | null {
  if (!destination) return null;
  if (destination.type === "bank_transfer") {
    return {
      type: "bank_transfer",
      countryCode: destination.countryCode,
      currencyCode: destination.currencyCode,
      institutionName: destination.institutionName,
      recipientName: destination.recipientName,
      identifier: buildCanonicalBankAccountIdentifier(destination.identifier),
    };
  }
  return {
    type: "contact_transfer",
    countryCode: destination.countryCode,
    currencyCode: destination.currencyCode,
    recipientName: destination.recipientName,
    identifier: { type: destination.identifier.type, value: destination.identifier.value },
  };
}

export function buildCanonicalPayload(input: { acceptCash: boolean; paymentDestination: PaymentDestination | null }): CanonicalPayload {
  return { acceptCash: input.acceptCash, paymentDestination: buildCanonicalDestination(input.paymentDestination) };
}

export function canonicalPayloadKey(payload: CanonicalPayload): string {
  return JSON.stringify(payload);
}

export function hashPayload(payload: CanonicalPayload): string {
  return createHash("sha256").update(canonicalPayloadKey(payload)).digest("hex");
}

// ─── Core (decoupled from https.onCall's auth/App-Check extraction so it is
// directly unit/integration-testable against the Firestore emulator via the
// Admin SDK, without requiring the Functions emulator) ─────────────────────

export interface SetVendorPaymentInstructionsInput {
  idempotencyKey?: unknown;
  acceptCash?: unknown;
  paymentDestination?: unknown;
}

export interface SetVendorPaymentInstructionsResult {
  success: true;
  recordId: string;
  version: number;
  changed: boolean;
}

/**
 * The trusted, already-authorized context this callable's core runs under.
 *
 * THIS MUST BE CONSTRUCTED ONLY BY AN AUTHENTICATED, ALREADY-AUTHORIZATION-
 * CHECKED SERVER-SIDE CALLER -- today, that is exclusively the
 * `setVendorPaymentInstructions` https.onCall wrapper below, after it has
 * verified Firebase Authentication, checked the caller's role is "vendor",
 * run App Check, and read `vendorId`/`uid` from the caller's own verified
 * auth token/custom claim.
 *
 * `runSetVendorPaymentInstructionsCore()` performs NO authentication, NO
 * authorization, and NO App Check verification of its own -- it trusts
 * every field on this context completely. `vendorId` and `uid` must never
 * be populated from `request.data`, a URL param, another document's field,
 * or any other client-influenced source: doing so bypasses vendor-
 * ownership enforcement entirely, silently and without error. If a future
 * admin tool, migration script, scheduled job, or other callable needs to
 * invoke this core, it must independently re-derive this exact context
 * from ITS OWN verified authentication/authorization -- never by relaying
 * a client-supplied vendorId, and never by constructing this object from
 * anything other than a source it has itself already authenticated.
 */
export interface AuthorizedVendorContext {
  uid: string;
  vendorId: string;
  appCheck: AppCheckContext;
}

export async function runSetVendorPaymentInstructionsCore(
  context: AuthorizedVendorContext,
  data: SetVendorPaymentInstructionsInput,
  requestId: string
): Promise<SetVendorPaymentInstructionsResult> {
  const { vendorId, uid } = context;

  const rawIdempotencyKey = data?.idempotencyKey;
  if (typeof rawIdempotencyKey !== "string" || rawIdempotencyKey.trim().length === 0) {
    throw new https.HttpsError("invalid-argument", "idempotencyKey is required.");
  }
  if (rawIdempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new https.HttpsError("invalid-argument", `idempotencyKey must be ${MAX_IDEMPOTENCY_KEY_LENGTH} characters or fewer.`);
  }
  // Deterministic doc id derived from the caller's own key via SHA-256 of
  // the full validated string (not lossy character replacement, unlike
  // payments/paymentLedger.ts's paymentIdFor -- see setVendorPaymentInstructions's
  // original Batch 2B audit finding; paymentIdFor itself is out of scope
  // and not touched here). The logical key stored on the record is the
  // validated original string, never the hash.
  const idempotencyDocId = createHash("sha256").update(rawIdempotencyKey).digest("hex");

  if (typeof data?.acceptCash !== "boolean") {
    throw new https.HttpsError("invalid-argument", "acceptCash must be a boolean.");
  }
  const acceptCash = data.acceptCash;

  const rawPaymentDestination = data?.paymentDestination;
  if (rawPaymentDestination === undefined) {
    throw new https.HttpsError("invalid-argument", "paymentDestination is required (use null to configure no structured destination).");
  }

  // Cheap structural rejection before any Firestore read: zero payment
  // options is invalid regardless of country/currency.
  if (rawPaymentDestination === null && acceptCash === false) {
    throw new https.HttpsError("invalid-argument", "Configure at least one way to be paid: a payment destination or Cash.");
  }

  const vendorRef = db.collection("vendors").doc(vendorId);
  const vendorSnap = await vendorRef.get();
  if (!vendorSnap.exists) {
    throw new https.HttpsError("not-found", "Vendor profile not found.");
  }
  const vendor = vendorSnap.data() ?? {};

  const vendorCountryCode = resolveVendorCountryCode(vendor);
  if (!vendorCountryCode) {
    throw new https.HttpsError(
      "failed-precondition",
      "Complete your business location before setting up payment instructions."
    );
  }
  const currencyCode = await resolveVendorCurrency(vendor);

  const paymentDestination = validatePaymentDestinationInput(rawPaymentDestination, vendorCountryCode, currencyCode);

  const canonicalPayload = buildCanonicalPayload({ acceptCash, paymentDestination });
  const payloadHash = hashPayload(canonicalPayload);

  const idemRef = vendorRef.collection("paymentInstructionsIdempotency").doc(idempotencyDocId);
  const currentRef = vendorRef.collection("paymentInstructionsCurrent").doc("current");

  const result = await db.runTransaction(async (tx) => {
    // ---- all reads first ----
    const idemSnap = await tx.get(idemRef);
    if (idemSnap.exists) {
      const cached = idemSnap.data()!;
      if (cached.payloadHash !== payloadHash) {
        throw new https.HttpsError(
          "invalid-argument",
          "This idempotency key was already used for a different payment-instructions update. Use a new key for a new change."
        );
      }
      // A retry, not a duplicate.
      return { recordId: cached.recordId as string, version: cached.version as number, changed: cached.changed as boolean };
    }

    const currentSnap = await tx.get(currentRef);
    const currentData = currentSnap.exists ? (currentSnap.data() as PaymentInstructionsCurrentDoc) : null;
    const currentVersion = currentData?.currentVersion ?? 0;

    const isSameAsCurrent =
      currentData !== null &&
      canonicalPayloadKey(canonicalPayload) ===
        canonicalPayloadKey(buildCanonicalPayload({ acceptCash: currentData.acceptCash, paymentDestination: currentData.paymentDestination }));

    if (isSameAsCurrent) {
      // New idempotency key, but the normalized configuration is identical
      // to what's already current: a no-op. No new historical record, no
      // version increment, no change event, no rewrite of `current`, and
      // deliberately no idempotency record either -- this path performs no
      // writes at all, so it is trivially safe to repeat under any key.
      return { recordId: currentData!.currentRecordId, version: currentData!.currentVersion, changed: false };
    }

    // ---- genuinely changed (or no current state yet); writes from here ----
    const newRecordRef = vendorRef.collection("paymentInstructions").doc();
    const nextVersion = currentVersion + 1;
    const changeEventRef = db.collection("paymentInstructionChangeEvents").doc();

    tx.set(newRecordRef, {
      recordId: newRecordRef.id,
      vendorId,
      version: nextVersion,
      acceptCash: canonicalPayload.acceptCash,
      paymentDestination,
      createdAt: FieldValue.serverTimestamp(),
      createdByUid: uid,
    });

    const nextCurrent: Omit<PaymentInstructionsCurrentDoc, "updatedAt"> & { updatedAt: FirebaseFirestore.FieldValue } = {
      currentRecordId: newRecordRef.id,
      currentVersion: nextVersion,
      acceptCash: canonicalPayload.acceptCash,
      paymentDestination,
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.set(currentRef, nextCurrent);

    const changeEvent: PaymentInstructionChangeEvent = {
      eventId: changeEventRef.id,
      vendorId,
      actorUid: uid,
      changedAt: FieldValue.serverTimestamp(),
      previousRecordId: currentData?.currentRecordId ?? null,
      newRecordId: newRecordRef.id,
      riskLevel: "normal",
      maskedIdentifierOld: currentData?.paymentDestination ? maskPaymentIdentifier(currentData.paymentDestination.identifier) : null,
      maskedIdentifierNew: paymentDestination ? maskPaymentIdentifier(paymentDestination.identifier) : null,
    };
    tx.set(changeEventRef, changeEvent);

    tx.set(idemRef, {
      idempotencyKey: rawIdempotencyKey,
      recordId: newRecordRef.id,
      version: nextVersion,
      changed: true,
      payloadHash,
      createdAt: FieldValue.serverTimestamp(),
    });

    return { recordId: newRecordRef.id, version: nextVersion, changed: true };
  });

  // No raw identifier in the generic audit log -- only the non-sensitive
  // outcome shape, matching every other sensitive callable's convention.
  await writeAuditLog({
    requestId,
    functionName: "setVendorPaymentInstructions",
    actorUid: uid,
    actorRole: "vendor",
    actorType: "vendor",
    targetType: "vendor",
    targetId: vendorId,
    eventType: "vendor.payment_instructions_set",
    after: { acceptCash, paymentDestinationConfigured: paymentDestination !== null, changed: result.changed, version: result.version },
    appCheck: context.appCheck,
  });

  return { success: true, recordId: result.recordId, version: result.version, changed: result.changed };
}

/**
 * setVendorPaymentInstructions.
 *
 * Batch 2B: the structured Payment Instructions callable -- worldwide.
 * Supports Bank Transfer (account number or IBAN, with an optional
 * supplementary routing code for account-number destinations) and Contact
 * Transfer (email or phone, naming no specific provider/network), plus
 * Accept Cash. countryCode/currencyCode are always server-derived from the
 * vendor's own resolved country -- never accepted as client input, and the
 * call hard-fails if no country can be resolved (no Nigeria/NGN fallback
 * for this callable -- see vendors/vendorCurrency.ts's
 * resolveVendorCountryCode). Entirely separate from the legacy
 * updateVendorPaymentInstructions callable, which is left unchanged and
 * keeps writing the free-text vendors/{vendorId}.paymentInstructions field
 * for old clients -- this callable never reads or writes that field, and
 * this record is never mirrored onto the public vendor document.
 *
 * institutionName/recipientName are bounded free text, not checked against
 * any authoritative institution catalogue (none exists in this
 * repository, and none is planned for this batch -- a mobile suggestion
 * list, if built, is UI convenience only and is never consulted here).
 * Identifier values are storage-safety validated only (required, bounded,
 * no control characters) -- this is never represented as account, IBAN,
 * email, or phone verification anywhere in this function, its errors, or
 * its audit trail. Phone numbers are validated/normalized via
 * libphonenumber-js using the vendor's own resolved country as parsing
 * context for national-format input -- this does NOT reuse
 * auth/phoneOtp.ts's normalizePhone(), which assumes any bare number is
 * Nigerian; that assumption is exactly what this callable must not repeat.
 */
export const setVendorPaymentInstructions = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "setVendorPaymentInstructions");

  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  // vendorId/uid come exclusively from the verified auth token/custom
  // claim above -- never from request.data -- and appCheck comes from the
  // verification call above, not a client-supplied value. This is the
  // ONLY place AuthorizedVendorContext is constructed.
  const context: AuthorizedVendorContext = {
    vendorId: request.auth.token.vendorId as string,
    uid: request.auth.uid,
    appCheck,
  };

  return runSetVendorPaymentInstructionsCore(
    context,
    (request.data ?? {}) as SetVendorPaymentInstructionsInput,
    requestId
  );
});
