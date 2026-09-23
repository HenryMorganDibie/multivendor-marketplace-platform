import { db } from "../admin";

/**
 * What currency a vendor trades in.
 *
 * A vendor sells in their own country's currency. That is not a preference and
 * it is not something a client should be able to state: an app that sends
 * "NGN" for a vendor in the United States is wrong, and the server has the
 * information to know it is wrong.
 *
 * createOrder already worked this way, reading currencyCode from the country
 * catalogue. createInvoice and createCatalogItem did not — both took whatever
 * the caller sent and fell back to NGN, and the mobile app sent a hardcoded
 * "NGN". So a vendor in the United States got NGN catalogue items and NGN
 * invoices while their subscription correctly showed USD. Same vendor, three
 * code paths, one of them right.
 *
 * This is that one path, extracted so the other two cannot drift from it again.
 * The country catalogue carries the currency for all 196 countries, so there is
 * no second list to maintain.
 *
 * NGN remains the fallback for a vendor whose record predates the country
 * catalogue, which is the situation the fallback was written for — not a
 * default for vendors whose country simply is not Nigeria.
 */
/**
 * The same country-resolution order resolveVendorCurrency() already used
 * inline, extracted so a second caller (setVendorPaymentInstructions, which
 * must not fall back to NGN when this is unresolvable) can determine the
 * exact same country a vendor's currency was derived from, rather than
 * running a second, differently-ordered lookup that could disagree with
 * this one for a malformed record with conflicting legacy/structured
 * fields. Behavior-preserving: resolveVendorCurrency's own fallback order
 * is unchanged by this extraction.
 */
export function resolveVendorCountryCode(
  vendor: FirebaseFirestore.DocumentData
): string | undefined {
  return (
    vendor.countryCode ??
    vendor.businessLocation?.countryCode ??
    vendor.location?.countryCode
  );
}

export async function resolveVendorCurrency(
  vendor: FirebaseFirestore.DocumentData
): Promise<string> {
  const countryCode = resolveVendorCountryCode(vendor);

  if (!countryCode) return "NGN";

  try {
    const snap = await db.collection("countries").doc(countryCode).get();
    return (snap.data()?.currencyCode as string) || "NGN";
  } catch {
    // A country lookup failing must not stop a vendor invoicing or listing an
    // item. Falling back is the lesser harm; throwing here would take out the
    // whole call over a reference read.
    return "NGN";
  }
}

/** The same, when only the vendor id is to hand. */
export async function resolveVendorCurrencyById(vendorId: string): Promise<string> {
  const snap = await db.collection("vendors").doc(vendorId).get();
  if (!snap.exists) return "NGN";
  return resolveVendorCurrency(snap.data() ?? {});
}
