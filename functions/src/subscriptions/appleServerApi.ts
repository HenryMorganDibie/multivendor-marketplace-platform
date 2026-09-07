import * as fs from "fs";
import * as path from "path";
import {
  AppStoreServerAPIClient,
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
} from "@apple/app-store-server-library";
import { SubscriptionPlanId } from "../types4";

/**
 * Apple App Store Server integration -- credentials and the two library
 * clients every Apple-facing function shares (the webhook handler and any
 * future callable that verifies a transaction directly from the app).
 *
 * SCAFFOLD: APPLE_IAP_KEY_ID and APPLE_IAP_ISSUER_ID are not real values yet
 * -- they come from the same App Store Connect key generation as the
 * private key (Users and Access -> Integrations -> In-App Purchase), which
 * has not been done. PRODUCT_ID_TO_PLAN is empty because the three
 * subscription products (Standard/Pro/Pro+) have not been created in App
 * Store Connect yet either. Nothing here can be exercised end-to-end until
 * both exist; this establishes the shape so wiring them in later is filling
 * in values, not writing new code.
 */

const BUNDLE_ID = "com.platform.app";

/**
 * Maps an Apple product identifier (configured per-subscription in App
 * Store Connect) to this app's own plan id.
 *
 * Only the plan tier lives here -- deliberately, per the client's question
 * about platform/country/billing-period/environment:
 *
 *  - Billing period (monthly/yearly) does not need its own dimension in
 *    this map. It is encoded directly in the product id string itself
 *    (the client's own convention below), and the actual renewal cadence a
 *    subscription is on comes from Apple's transaction data
 *    (expiresDate/purchaseDate) at verification time, not from this
 *    lookup. Adding yearly products later is adding two more keys here,
 *    not restructuring the map.
 *  - Country is not a dimension at all: Apple product ids are global:
 *    the same id is sold at different prices per storefront automatically
 *    through App Store Connect's own pricing tiers. Nothing in this
 *    backend needs to know which storefront a purchase came from to
 *    resolve which plan it is.
 *  - Platform (Apple vs a future Google Play) is not a dimension of this
 *    map either -- it does not need to be, because the two platforms'
 *    product id namespaces are disjoint by construction (Apple's are this
 *    app's own reverse-DNS bundle id; Google Play SKUs are a separate
 *    string space that will never collide with these). The provider that
 *    a given event came from is already tracked one level up, on
 *    NormalizedWebhookEvent.provider ("apple" | "google" | ...) and
 *    written to subscriptionEvents/vendorSubscriptions from there -- a
 *    second Google Play version of this same file will have its own
 *    PRODUCT_ID_TO_PLAN, keyed by Google's SKU strings, and nothing here
 *    changes when that's added.
 *  - Environment (sandbox/production) is a property of which credentials
 *    and which SignedDataVerifier instance handle a request, not of which
 *    plan a product id maps to -- see APPLE_ENVIRONMENT below. The same
 *    product id means the same plan in both environments.
 */
export const PRODUCT_ID_TO_PLAN: Record<string, SubscriptionPlanId> = {
  "com.platform.app.standard.monthly": "standard",
  "com.platform.app.pro.monthly": "pro",
  "com.platform.app.proplus.monthly": "pro_plus",
  // Yearly convention, added the moment these exist in App Store Connect:
  // "com.platform.app.standard.yearly": "standard",
  // "com.platform.app.pro.yearly": "pro",
  // "com.platform.app.proplus.yearly": "pro_plus",
};

function getKeyId(): string {
  return process.env.APPLE_IAP_KEY_ID ?? "";
}

function getIssuerId(): string {
  return process.env.APPLE_IAP_ISSUER_ID ?? "";
}

/**
 * The .p8 private key's actual bytes, injected at runtime from Google
 * Secret Manager (bound via the `secrets: ["APPLE_IAP_PRIVATE_KEY"]` option
 * on each function that needs it -- see appleWebhook.ts). Never read from a
 * plain env var or committed file the way Stripe/Flutterwave/Paystack's
 * keys are, since the client generates and owns this one directly rather than
 * handing it to Henry to configure.
 */
function getPrivateKey(): string {
  return process.env.APPLE_IAP_PRIVATE_KEY ?? "";
}

function isConfigured(): boolean {
  return !!(getKeyId() && getIssuerId() && getPrivateKey());
}

/**
 * The environment WE target when WE initiate an outbound call to Apple
 * (requestTestNotification, looking up a transaction by id) -- there is no
 * ambiguity here, since we choose which environment we mean. Defaults to
 * sandbox: platform-dev has no production App Store listing yet. Once one
 * exists, set APPLE_IAP_ENVIRONMENT=production for calls that should target
 * it (a plain, non-secret env var, same .env.<project> file the Key ID/
 * Issuer ID live in).
 *
 * This is deliberately NOT used for verifying INBOUND notifications/
 * transactions below -- those can legitimately arrive from either
 * environment at the same time (ongoing sandbox testing alongside live
 * production traffic), and this app-wide setting has no way to know which
 * one a given payload is actually from. getSignedDataVerifier() below
 * handles that per-payload instead.
 */
const APPLE_OUTBOUND_ENVIRONMENT =
  process.env.APPLE_IAP_ENVIRONMENT === "production" ? Environment.PRODUCTION : Environment.SANDBOX;

export function getAppStoreServerClient(): AppStoreServerAPIClient {
  if (!isConfigured()) {
    throw new Error(
      "Apple App Store Server API is not configured: APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID and APPLE_IAP_PRIVATE_KEY must all be set."
    );
  }
  return new AppStoreServerAPIClient(getPrivateKey(), getKeyId(), getIssuerId(), BUNDLE_ID, APPLE_OUTBOUND_ENVIRONMENT);
}

const cachedVerifiers = new Map<Environment, SignedDataVerifier>();

function buildVerifier(environment: Environment): SignedDataVerifier {
  const rootCert = fs.readFileSync(path.join(__dirname, "apple-certs", "AppleRootCA-G3.cer"));
  return new SignedDataVerifier(
    [rootCert],
    true, // enableOnlineChecks: revocation + expiry checked against real time
    environment,
    BUNDLE_ID,
  );
}

function getVerifierFor(environment: Environment): SignedDataVerifier {
  let verifier = cachedVerifiers.get(environment);
  if (!verifier) {
    verifier = buildVerifier(environment);
    cachedVerifiers.set(environment, verifier);
  }
  return verifier;
}

/**
 * SignedDataVerifier checks the JWS signature chain on every transaction/
 * notification payload back to Apple's own root certificate -- this is
 * what actually proves a payload came from Apple and was not forged
 * client-side, the same trust boundary a webhook signature check gives the
 * Stripe/Flutterwave/Paystack handlers.
 *
 * Sandbox and production can both be sending real traffic at the same time
 * (ongoing sandbox testing continues after a production listing goes
 * live), and a payload does not say up front which one it is -- the
 * library only tells you by rejecting it with INVALID_ENVIRONMENT if you
 * guessed wrong. So this tries sandbox first (sandbox is the only
 * environment this project has ever had traffic from) and falls back to
 * production only on that specific rejection, rather than on any other
 * verification failure. Each environment gets its own cached verifier
 * instance -- the constructor's target environment is fixed for its
 * lifetime, so one instance genuinely cannot serve both.
 */
export async function verifyAndDecodeNotification(signedPayload: string) {
  try {
    return await getVerifierFor(Environment.SANDBOX).verifyAndDecodeNotification(signedPayload);
  } catch (err) {
    if (err instanceof VerificationException && err.status === VerificationStatus.INVALID_ENVIRONMENT) {
      return await getVerifierFor(Environment.PRODUCTION).verifyAndDecodeNotification(signedPayload);
    }
    throw err;
  }
}

/**
 * Same sandbox-then-production fallback as verifyAndDecodeNotification,
 * for the nested signedTransactionInfo JWS inside a notification -- it can
 * be from either environment independently of which one the outer
 * notification turned out to be (they are always the same in practice, but
 * nothing in the library guarantees it, so this re-runs the same fallback
 * rather than assuming the outer result and reusing its verifier).
 */
export async function verifyAndDecodeTransaction(signedTransactionInfo: string) {
  try {
    return await getVerifierFor(Environment.SANDBOX).verifyAndDecodeTransaction(signedTransactionInfo);
  } catch (err) {
    if (err instanceof VerificationException && err.status === VerificationStatus.INVALID_ENVIRONMENT) {
      return await getVerifierFor(Environment.PRODUCTION).verifyAndDecodeTransaction(signedTransactionInfo);
    }
    throw err;
  }
}
