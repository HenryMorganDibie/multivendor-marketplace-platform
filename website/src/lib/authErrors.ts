/**
 * Sign-in failures, turned into something a person can act on.
 *
 * The CMS login page caught every rejection and rendered one fixed line,
 * "Incorrect email or password.", so a disabled admin account, a rate limit
 * and a dropped connection were indistinguishable. Firebase carries the
 * machine-readable reason on `.code`; that is what this reads.
 *
 * `field` travels with the message so the page can attach it to the input it
 * belongs to and put focus there, rather than showing one line under the form
 * and leaving the admin to work out which box is wrong.
 *
 * Kept in step with the mobile app's `lib/auth/authErrors.ts` and the vendor
 * portal's copy: the same condition should read the same way wherever someone
 * meets it.
 */

export type AuthErrorField = "email" | "password" | "form";

export interface MappedAuthError {
  field: AuthErrorField;
  message: string;
}

function reasonOf(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  // The code is authoritative; the message is only a fallback.
  return `${code} ${message}`;
}

export function mapLoginError(error: unknown): MappedAuthError {
  const reason = reasonOf(error);

  if (/invalid-email/.test(reason)) {
    return { field: "email", message: "Enter a valid email address." };
  }
  /**
   * Wrong password, unknown account and Firebase's newer catch-all resolve to
   * the same wording on purpose. Telling them apart would reveal which
   * addresses have accounts here, which is account enumeration for no gain.
   */
  if (/invalid-credential|wrong-password|user-not-found/.test(reason)) {
    return { field: "password", message: "Incorrect email or password." };
  }
  if (/user-disabled/.test(reason)) {
    return {
      field: "form",
      message: "Your account has been disabled. Contact Platform Support.",
    };
  }
  if (/email-not-verified/.test(reason)) {
    return { field: "form", message: "Please verify your email before logging in." };
  }
  if (/too-many-requests/.test(reason)) {
    return {
      field: "form",
      message: "Too many failed attempts. Please try again in 15 minutes.",
    };
  }
  if (/network-request-failed/.test(reason)) {
    return {
      field: "form",
      message: "We could not reach Platform. Check your connection and try again.",
    };
  }

  // Reserved for genuine server or network faults: the only case where trying
  // again is real advice.
  return { field: "form", message: "Something went wrong on our side. Please try again." };
}
