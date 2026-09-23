/**
 * Which backend callables anything actually calls, grouped by who owns them.
 *
 * A raw count of uncalled functions cannot tell you whether anything is
 * missing. A scheduled job has no caller by design; an Admin Portal function
 * has no caller because that portal does not exist yet; a vendor-app function
 * with no caller is a gap in something already delivered. Those are three
 * different facts and only the last one is work owed.
 *
 * So this classifies rather than counts, and every function lands in exactly
 * one group with a stated reason.
 *
 *   node audit-callable-coverage.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const BACKEND_SRC = path.resolve(__dirname, "../functions/src");

const CLIENTS = {
  mobile: path.join(ROOT, "multivendor-marketplace-mobile", "expo"),
  "vendor-portal": path.join(ROOT, "this repo (vendor-portal/)", "src"),
  website: path.join(ROOT, "this repo (website/)", "src"),
};

/**
 * Invoked by Google, not by a client: Firestore triggers, scheduled jobs and
 * provider webhooks. No caller is expected and their absence is correct.
 */
const TRIGGERS = new Set([
  "onUserCreate", "onUserDelete", "onVendorWrite", "onCatalogItemWrite",
  "onRatingWrite", "onCountryAvailabilityWrite", "onVendorVerificationDocumentWrite",
  "cleanupExpiredInvoiceVisibility", "cleanupOrphanedAccount", "cleanupOrphanedAccounts",
  "expireStaleSubscriptions", "gracePeriodReminder",
  "handlePaystackWebhook", "handleFlutterwaveWebhook", "handleStripeWebhook",
  "handleChangeRequest",
]);

/**
 * The admin console — moderation, verification decisions, admin access,
 * support, and manual subscription control. The CMS at /cms in the website is
 * the beginning of this surface; these are the operational functions it does
 * not yet cover.
 */
const ADMIN_PORTAL = new Set([
  "approveVendorVerification", "rejectVendorVerification", "requestVerificationRetry",
  "suspendVendor", "deactivateVendor", "reactivateVendor",
  "approveCatalogItem", "rejectCatalogItem", "listCatalogModerationQueue",
  "getCatalogItemModeration", "moderateRating", "reviewModerationRestriction",
  "seedDefaultModerationRules", "createAdminInvite", "acceptAdminInvite",
  "revokeAdminAccess", "recordAdminSession", "applyManualSubscriptionOverride",
  "cancelSubscriptionAdmin", "seedSubscriptionPlans", "assignSupportTicket",
  "resolveSupportTicket", "reviewPaymentProof", "saveSiteContentDraft",
  "publishSiteContent", "getSiteContentDraft",
]);

/** The vendor web portal, which has its own scope and milestone. */
const VENDOR_PORTAL = new Set([
  "getVendorPortalAccess", "generateVendorPortalHandoffUrl",
  "getVendorBillingHistory", "getVendorSubscriptionOfferings",
]);

/**
 * Deliberately not built into the MVP client. Each is deployed because the
 * backend milestone that specified it is complete; the client half was scoped
 * out rather than missed.
 */
const POST_MVP = new Set([
  "createAiHelpThread",       // AI assistant is a later phase
  "getReceipt",               // receipts are post-MVP; invoices cover the need
  "createExternalOrder",      // external order recording, phase 6+
  "submitDeliveryContact",    // delivery contact capture, not in MVP fulfilment
  "getClaimsVersion",         // diagnostic, used by support rather than a screen
]);

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (/^(node_modules|\.next|\.expo|dist|build|coverage)$/.test(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) acc.push(p);
  }
  return acc;
}

function backendExports() {
  const names = new Set();
  for (const file of walk(BACKEND_SRC)) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/export const (\w+)\s*=\s*(https\.onCall|onSchedule|onRequest|functionsFirestore|functions\.)/g)) {
      names.add(m[1]);
    }
  }
  const index = path.join(BACKEND_SRC, "index.ts");
  if (fs.existsSync(index)) {
    const src = fs.readFileSync(index, "utf8");
    for (const m of src.matchAll(/export \{\s*([^}]+)\s*\}/g)) {
      for (const raw of m[1].split(",")) {
        const name = raw.trim().split(/\s+as\s+/).pop().trim();
        if (/^\w+$/.test(name)) names.add(name);
      }
    }
  }
  return [...names].sort();
}

function callsPerClient() {
  const calls = {};
  for (const [client, dir] of Object.entries(CLIENTS)) {
    const found = new Set();
    for (const file of walk(dir)) {
      const src = fs.readFileSync(file, "utf8");
      // Type arguments are routinely written across several lines, so the
      // generic body must be allowed to span them — matched lazily so it stops
      // at the `>(` opening the arguments rather than a `>` inside a type.
      for (const m of src.matchAll(
        /(?:callable|httpsCallable)\s*(?:<[\s\S]*?>)?\s*\(\s*(?:[\w.]+\s*,\s*)?["'](\w+)["']/g
      )) {
        found.add(m[1]);
      }
    }
    calls[client] = found;
  }
  return calls;
}

function main() {
  const exports_ = backendExports();
  const calls = callsPerClient();
  const isCalled = (n) => Object.values(calls).some((s) => s.has(n));

  const groups = {
    called: [],
    triggers: [],
    adminPortal: [],
    vendorPortal: [],
    postMvp: [],
    mobileGaps: [],
  };

  for (const name of exports_) {
    if (isCalled(name)) {
      const by = Object.entries(calls).filter(([, s]) => s.has(name)).map(([c]) => c);
      groups.called.push({ name, by });
    } else if (TRIGGERS.has(name)) groups.triggers.push(name);
    else if (ADMIN_PORTAL.has(name)) groups.adminPortal.push(name);
    else if (VENDOR_PORTAL.has(name)) groups.vendorPortal.push(name);
    else if (POST_MVP.has(name)) groups.postMvp.push(name);
    else groups.mobileGaps.push(name);
  }

  const line = (label, n) => console.log(`  ${label.padEnd(46)} ${String(n).padStart(3)}`);

  console.log(`Backend exports: ${exports_.length}\n`);
  line("Called by a client", groups.called.length);
  line("Triggers / scheduled / webhooks (no caller by design)", groups.triggers.length);
  line("Admin Portal (surface not built)", groups.adminPortal.length);
  line("Vendor Portal (separate scope)", groups.vendorPortal.length);
  line("Post-MVP (client half deliberately out of scope)", groups.postMvp.length);
  line("GENUINE MOBILE WIRING GAPS", groups.mobileGaps.length);

  console.log("\nCalled by:");
  for (const [client, set] of Object.entries(calls)) console.log(`  ${client.padEnd(14)} ${set.size}`);

  console.log("\nGENUINE MOBILE WIRING GAPS — delivered features with no caller:");
  for (const n of groups.mobileGaps) console.log(`  ${n}`);

  fs.writeFileSync(
    path.join(__dirname, "callable-coverage.json"),
    JSON.stringify(groups, null, 2)
  );
  console.log("\nWritten to scripts/callable-coverage.json");
}

main();
