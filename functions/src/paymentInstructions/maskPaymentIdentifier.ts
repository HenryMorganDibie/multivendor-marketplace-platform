import { BankAccountIdentifier, ContactIdentifier } from "../types5";

/**
 * Masks a payment identifier for audit-log/change-event purposes,
 * identifier-type-aware. This is a display/logging convenience only -- it
 * is never the security boundary. The actual boundary is Firestore Rules
 * denying all direct client reads/writes of the underlying
 * paymentInstructions/paymentInstructionsCurrent documents; this helper
 * exists solely so paymentInstructionChangeEvents and the generic audit
 * log never carry a raw account number, IBAN, email, or phone, per their
 * own documented contract (see types5.ts).
 *
 * Deliberately identifier-type-driven, not destination-type-driven: it
 * only looks at identifier.type/value, so it works unmodified for both
 * BankTransferDestination and ContactTransferDestination. Routing codes
 * and swiftBic are never passed to this function and never appear in any
 * masked or audit representation -- they are bank-internal routing
 * metadata, not the payer-facing identifier.
 */
export function maskPaymentIdentifier(identifier: BankAccountIdentifier | ContactIdentifier): string {
  switch (identifier.type) {
    case "account_number":
      return maskAccountNumberValue(identifier.value);
    case "iban":
      return maskIbanValue(identifier.value);
    case "email":
      return maskEmailValue(identifier.value);
    case "phone":
      return maskPhoneValue(identifier.value);
  }
}

/** Last 4 characters visible, rest replaced -- unchanged behavior from the prior account-number-only helper. */
function maskAccountNumberValue(value: string): string {
  if (value.length <= 4) {
    return "•".repeat(value.length);
  }
  return `${"•".repeat(value.length - 4)}${value.slice(-4)}`;
}

/** Same masking shape as an account number -- an IBAN's last 4 characters are its own country-check-digit-free account tail in most schemes, not reversible to the full value. */
function maskIbanValue(value: string): string {
  if (value.length <= 4) {
    return "•".repeat(value.length);
  }
  return `${"•".repeat(value.length - 4)}${value.slice(-4)}`;
}

/** Keeps the first character of the local part and the whole domain -- enough to recognize, never the full address. */
function maskEmailValue(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0) return "•".repeat(value.length); // malformed input should never reach here post-validation, but never throw from a masking helper
  const localPart = value.slice(0, at);
  const domain = value.slice(at);
  const visible = localPart.slice(0, 1);
  return `${visible}${"•".repeat(Math.max(localPart.length - 1, 0))}${domain}`;
}

/** Keeps only the last 2-4 digits, matching common SMS-verification masking conventions -- never the full number. */
function maskPhoneValue(value: string): string {
  const visibleCount = value.length > 6 ? 4 : 2;
  if (value.length <= visibleCount) {
    return "•".repeat(value.length);
  }
  return `${"•".repeat(value.length - visibleCount)}${value.slice(-visibleCount)}`;
}
