import { google, androidpublisher_v3 } from "googleapis";
import { SubscriptionPlanId } from "../types4";

/**
 * Google Play Developer API integration -- the Play Billing counterpart to
 * appleServerApi.ts. Same SCAFFOLD status: PACKAGE_NAME is real (matches
 * the app's actual package id), but nothing else here is exercisable until
 * the Founder provides a service account with the Play Developer API enabled
 * and creates the real subscription products in Play Console.
 */

const PACKAGE_NAME = "com.platform.app";

/**
 * Maps a Google Play product id to this app's own plan id. Mirrors
 * appleServerApi.ts's PRODUCT_ID_TO_PLAN exactly -- same reasoning on why
 * billing period/country/platform aren't dimensions of this map, see that
 * file's header comment. Empty because the real product ids don't exist
 * in Play Console yet; fill in once the Founder creates them, matching
 * whatever ids she actually creates (they do not have to match Apple's
 * strings, Play Console has its own naming rules).
 */
export const GOOGLE_PRODUCT_ID_TO_PLAN: Record<string, SubscriptionPlanId> = {
  // "standard_monthly": "standard",
  // "pro_monthly": "pro",
  // "pro_plus_monthly": "pro_plus",
};

/**
 * The service account's credentials JSON, injected at runtime from Google
 * Secret Manager the same way Apple's private key is -- the Founder generates
 * and owns this directly (Play Console -> API access -> a service account
 * with the Play Developer API enabled), never a plain env var.
 */
function getServiceAccountJson(): string {
  return process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON ?? "";
}

function isConfigured(): boolean {
  return !!getServiceAccountJson();
}

let cachedClient: androidpublisher_v3.Androidpublisher | null = null;

function getAuthClient() {
  const credentials = JSON.parse(getServiceAccountJson());
  return new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
}

export function getAndroidPublisherClient(): androidpublisher_v3.Androidpublisher {
  if (cachedClient) return cachedClient;
  if (!isConfigured()) {
    throw new Error("Google Play Developer API is not configured: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON must be set.");
  }
  cachedClient = google.androidpublisher({ version: "v3", auth: getAuthClient() });
  return cachedClient;
}

/**
 * Fetches the full subscription purchase record for a given purchaseToken.
 * This is the Google equivalent of Apple's verifyAndDecodeTransaction --
 * Google's RTDN payload itself carries only packageName/subscriptionId/
 * purchaseToken, never the plan-holder's identity or current state, so a
 * real API call is required to get subscriptionState, the current
 * lineItems (product id, expiry), and externalAccountIdentifiers (where
 * obfuscatedExternalAccountId -- this app's vendorId, passed at purchase
 * time -- comes back out).
 */
export async function getSubscriptionPurchaseV2(
  purchaseToken: string,
): Promise<androidpublisher_v3.Schema$SubscriptionPurchaseV2> {
  const client = getAndroidPublisherClient();
  const response = await client.purchases.subscriptionsv2.get({
    packageName: PACKAGE_NAME,
    token: purchaseToken,
  });
  return response.data;
}
