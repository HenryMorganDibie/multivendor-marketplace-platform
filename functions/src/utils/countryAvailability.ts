import { db } from "../admin";

/**
 * Checks whether a country is available for commerce (chat, orders).
 * Fails closed: missing or non-ACTIVE document rejects the operation.
 *
 * Per the client: "If the document is missing or disabled, reject safely."
 */
export async function isCountryActive(countryCode: string): Promise<boolean> {
  if (!countryCode) return false;

  const snap = await db.collection("countryAvailability").doc(countryCode).get();
  if (!snap.exists) return false;

  return snap.data()?.status === "ACTIVE";
}
