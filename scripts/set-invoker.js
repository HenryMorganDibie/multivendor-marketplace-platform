/**
 * Grants allUsers the invoker role on Gen 2 callables, directly.
 *
 * The alternative is deleting and recreating every affected function, because
 * Firebase only applies the invoker binding at creation. That is slow,
 * destructive, and — worse — unreliable in batches: setIamPolicy is itself rate
 * limited, so a batch of eight reports eight successful creates while silently
 * failing to bind some of them. It can leave a function *less* reachable than
 * before, which is what happened here.
 *
 * A Gen 2 function is a Cloud Run service underneath, named as the function
 * lowercased. Setting run.invoker on that service is the same thing Firebase
 * does, without touching the deployment at all.
 *
 *   node set-invoker.js <fn> [fn...]        # named functions
 *   node set-invoker.js --all               # every callable in source
 *   node set-invoker.js --check <fn>        # read the policy, change nothing
 */
const { GoogleAuth } = require("google-auth-library");

const PROJECT = "platform-dev";
const REGION = "us-central1";

// Invoked by Cloud Scheduler, never by a client. Opening these would expose
// jobs that delete accounts and expire subscriptions to anyone with the URL.
const SCHEDULED = new Set([
  "cleanupOrphanedAccounts",
  "expireStaleSubscriptions",
  "gracePeriodReminder",
  "cleanupExpiredInvoiceVisibility",
]);

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

function serviceUrl(fn) {
  return `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/services/${fn.toLowerCase()}`;
}

async function getPolicy(client, fn) {
  const res = await client.request({ url: `${serviceUrl(fn)}:getIamPolicy`, method: "GET" });
  return res.data;
}

async function setPublic(client, fn) {
  const policy = await getPolicy(client, fn).catch(() => ({}));
  const bindings = policy.bindings ?? [];

  const existing = bindings.find((b) => b.role === "roles/run.invoker");
  if (existing?.members?.includes("allUsers")) return "already-public";

  if (existing) existing.members = [...new Set([...(existing.members ?? []), "allUsers"])];
  else bindings.push({ role: "roles/run.invoker", members: ["allUsers"] });

  await client.request({
    url: `${serviceUrl(fn)}:setIamPolicy`,
    method: "POST",
    data: { policy: { bindings } },
  });
  return "granted";
}

async function main() {
  const args = process.argv.slice(2);
  const client = await auth.getClient();

  if (args[0] === "--check") {
    const policy = await getPolicy(client, args[1]);
    console.log(JSON.stringify(policy, null, 2));
    return;
  }

  let names = args.filter((a) => !a.startsWith("--"));
  if (args.includes("--all")) {
    process.env.GCLOUD_PROJECT = PROJECT;
    process.env.GOOGLE_CLOUD_PROJECT = PROJECT;
    names = Object.keys(require("../functions/lib/index.js"));
  }
  names = names.filter((n) => !SCHEDULED.has(n));

  let granted = 0, already = 0, failed = 0;
  for (const fn of names) {
    try {
      const result = await setPublic(client, fn);
      if (result === "granted") { granted++; console.log(`  granted   ${fn}`); }
      else { already++; }
    } catch (e) {
      failed++;
      const msg = e?.response?.data?.error?.message ?? e.message;
      console.log(`  FAILED    ${fn}: ${String(msg).slice(0, 110)}`);
    }
  }

  console.log(`\ngranted ${granted}, already public ${already}, failed ${failed}`);
  console.log(`scheduled jobs deliberately skipped: ${[...SCHEDULED].join(", ")}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e?.response?.data?.error?.message ?? e.message);
  process.exit(1);
});
