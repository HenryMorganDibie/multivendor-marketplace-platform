import { db } from "../admin";
import { SiteContentDoc } from "../types4";

/**
 * Records which legal documents a user agreed to, and at which version.
 *
 * Read on the server rather than accepted from the client. The client could
 * otherwise claim any version number, and this is the record that says what
 * someone agreed to, so it has to come from the same documents the site
 * publishes.
 *
 * The version captured here is a point-in-time snapshot. Publishing a new
 * version of a document later increments siteContent/{id}.version but never
 * touches an existing user's acceptance, so the historical record of what each
 * person actually agreed to survives every future edit.
 */

/** siteContent document ids, matching the website's legal routes. */
const TERMS_SECTION = "terms-of-service";
const PRIVACY_SECTION = "privacy-policy";
const VENDOR_AGREEMENT_SECTION = "vendor-terms";
const CUSTOMER_AGREEMENT_SECTION = "customer-terms";

export interface LegalAcceptanceRecord {
  termsVersion: number | null;
  privacyVersion: number | null;
  /** Whichever agreement applies to the role being registered. */
  vendorAgreementVersion?: number | null;
  customerAgreementVersion?: number | null;
  /** The consent wording shown at the point of acceptance, so the record says
   *  what the user was actually asked, not just which documents existed. */
  consentText: string;
  acceptedFrom: "mobile_registration";
}

const VENDOR_CONSENT_TEXT =
  "By creating a vendor account, you agree to Laetiva's Terms of Use, Privacy Policy, and Vendor Agreement.";
const CUSTOMER_CONSENT_TEXT =
  "By creating a customer account, you agree to Laetiva's Terms of Use, Privacy Policy, and Customer Agreement.";

/**
 * Reads the currently published version of each document that applies to this
 * role.
 *
 * A null version means the document has not been published through the CMS yet.
 * That is recorded honestly rather than defaulted to 1: a user cannot have
 * agreed to a specific version of something that had no published version at
 * the time, and writing a number that never existed would make the record worse
 * than useless if it were ever relied on.
 */
export async function captureLegalAcceptance(
  role: "customer" | "vendor"
): Promise<LegalAcceptanceRecord> {
  const agreementSection =
    role === "vendor" ? VENDOR_AGREEMENT_SECTION : CUSTOMER_AGREEMENT_SECTION;

  const [termsSnap, privacySnap, agreementSnap] = await Promise.all([
    db.collection("siteContent").doc(TERMS_SECTION).get(),
    db.collection("siteContent").doc(PRIVACY_SECTION).get(),
    db.collection("siteContent").doc(agreementSection).get(),
  ]);

  const publishedVersion = (snap: FirebaseFirestore.DocumentSnapshot): number | null => {
    if (!snap.exists) return null;
    const data = snap.data() as SiteContentDoc;
    // Only a published document counts. A draft has a version number but has
    // never been shown to anyone, so nobody can have agreed to it.
    return data.publishedContent ? data.version : null;
  };

  const record: LegalAcceptanceRecord = {
    termsVersion: publishedVersion(termsSnap),
    privacyVersion: publishedVersion(privacySnap),
    consentText: role === "vendor" ? VENDOR_CONSENT_TEXT : CUSTOMER_CONSENT_TEXT,
    acceptedFrom: "mobile_registration",
  };

  if (role === "vendor") {
    record.vendorAgreementVersion = publishedVersion(agreementSnap);
  } else {
    record.customerAgreementVersion = publishedVersion(agreementSnap);
  }

  return record;
}
