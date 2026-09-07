import { https } from "firebase-functions/v2";
import { db, Timestamp } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { OrderDoc } from "../types2";
import { sumLedger } from "../payments/paymentLedger";
import { readVendorRevenueTotal } from "../payments/vendorRevenueTotals";
import { resolveEffectivePlan } from "../subscriptions/resolveEffectivePlan";
import { DashboardFilterRange } from "../types4";

const RANGE_RANK: Record<DashboardFilterRange, number> = { today: 0, week: 1, month: 2, year: 3 };
const RANGE_MS: Record<DashboardFilterRange, number> = {
  today: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000,
};

/** Clamps a client-requested range down to whatever the vendor's plan
 * actually allows — never up. A Basic vendor asking for "week" data gets
 * "today" data back, not an error, matching the spec's clamp option. */
function clampRange(requested: unknown, maxAllowed: DashboardFilterRange): DashboardFilterRange {
  const req = typeof requested === "string" && requested in RANGE_RANK ? (requested as DashboardFilterRange) : maxAllowed;
  return RANGE_RANK[req] > RANGE_RANK[maxAllowed] ? maxAllowed : req;
}

function startOfToday(): Timestamp {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return Timestamp.fromDate(d);
}

async function requireVendorId(request: https.CallableRequest<unknown>): Promise<string> {
  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string | undefined;
  if (!vendorId) throw new https.HttpsError("failed-precondition", "Vendor ID could not be determined.");
  return vendorId;
}

/**
 * getVendorDashboard (Phase 4, Section 2.2).
 *
 * The five "Live" widgets (orders today, pending orders, today's revenue,
 * today's schedule, upcoming orders) are never gated and always computed
 * against a literal today window, regardless of plan or requested range.
 * Best Seller and Revenue Card are Phase 4 gates: included automatically
 * when the plan allows, or rejected with permission-denied if explicitly
 * requested (includeWidgets) without access — never silently included for
 * a plan that shouldn't have them.
 */
export const getVendorDashboard = https.onCall(async (request) => {
  checkAppCheck(request, "getVendorDashboard");
  const vendorId = await requireVendorId(request);
  const { limits: planLimits } = await resolveEffectivePlan(vendorId);

  const includeWidgets: string[] = Array.isArray((request.data as { includeWidgets?: unknown } | undefined)?.includeWidgets)
    ? (request.data as { includeWidgets: string[] }).includeWidgets
    : [];
  if (includeWidgets.includes("bestSeller") && !planLimits.canViewBestSellerWidget) {
    throw new https.HttpsError("permission-denied", "Best seller widget is not available on your current plan.");
  }
  if (includeWidgets.includes("revenueCard") && !planLimits.canViewRevenueCard) {
    throw new https.HttpsError("permission-denied", "Revenue card widget is not available on your current plan.");
  }

  const filterRange = clampRange((request.data as { filterRange?: unknown } | undefined)?.filterRange, planLimits.dashboardFilterRange);

  const todayStart = startOfToday();
  const todayOrdersSnap = await db.collection("orders")
    .where("vendorId", "==", vendorId)
    .where("createdAt", ">=", todayStart)
    .get();
  const todayOrders = todayOrdersSnap.docs.map((d) => d.data() as OrderDoc);

  const ordersToday = todayOrders.length;
  const pendingOrders = todayOrders.filter((o) => ["requested", "accepted", "confirmed", "in_progress"].includes(o.status)).length;
  const upcomingOrders = todayOrders.filter((o) => ["accepted", "confirmed", "in_progress"].includes(o.status)).length;

  /**
   * Revenue comes from the payment ledger, not from orders.
   *
   * This summed the totals of orders completed today. That is a count of work
   * finished, not of money received, and it reintroduced exactly what the
   * ledger was built to remove: it cannot express a partial payment, ignores a
   * reversal entirely, and counts an order and its invoice as two amounts.
   *
   * The two genuinely differ and the ledger's answer is the right one. An order
   * completed today but not yet paid is not revenue. A payment that arrived
   * today against last week's order is. A vendor recording a payment and
   * watching this figure not move was the visible symptom.
   *
   * Read through the same helpers getVendorRevenue uses, so the dashboard and
   * the invoice screens cannot drift apart again.
   */
  const todayPaymentsSnap = await db.collection("payments")
    .where("vendorId", "==", vendorId)
    .where("paidAt", ">=", todayStart)
    .get();

  const todayRevenue = sumLedger(
    todayPaymentsSnap.docs.map((d) => ({
      amountMinorUnits: (d.data().amountMinorUnits as number) ?? 0,
      type: d.data().type as "payment" | "reversal",
    })),
  );

  // The lifetime figure is the maintained total rather than a scan, and
  // outstanding is filtered in the query so a vendor with years of settled
  // invoices reads only what is still owed.
  const totalRevenue = await readVendorRevenueTotal(vendorId);

  const owedSnap = await db.collection("invoices")
    .where("vendorId", "==", vendorId)
    .where("status", "in", ["unpaid", "partial"])
    .get();
  const outstandingRevenue = owedSnap.docs.reduce(
    (sum, d) => sum + ((d.data().balanceMinorUnits as number) ?? 0),
    0,
  );

  const response: Record<string, unknown> = {
    success: true,
    planLimits,
    filterRange,
    ordersToday,
    pendingOrders,
    todayRevenue,
    // Sent alongside so the dashboard has the whole ledger picture without a
    // second call, and without recomputing any of it client-side.
    totalRevenue,
    outstandingRevenue,
    todaysSchedule: todayOrders
      .filter((o) => ["accepted", "confirmed", "in_progress"].includes(o.status))
      .map((o) => ({ orderId: o.orderId, publicOrderId: o.publicOrderId, status: o.status, fulfillmentType: o.fulfillmentType })),
    upcomingOrders,
  };

  if (planLimits.canViewBestSellerWidget || planLimits.canViewRevenueCard) {
    const rangeStart = Timestamp.fromMillis(Date.now() - RANGE_MS[filterRange]);
    const rangeOrdersSnap = await db.collection("orders")
      .where("vendorId", "==", vendorId)
      .where("createdAt", ">=", rangeStart)
      .get();
    const rangeOrders = rangeOrdersSnap.docs.map((d) => d.data() as OrderDoc).filter((o) => o.status === "completed");

    if (planLimits.canViewRevenueCard) {
      response.revenueCard = { total: rangeOrders.reduce((sum, o) => sum + (o.orderSnapshot?.total ?? 0), 0), orderCount: rangeOrders.length, range: filterRange };
    }
    if (planLimits.canViewBestSellerWidget) {
      const itemCounts = new Map<string, { name: string; quantity: number }>();
      for (const order of rangeOrders) {
        for (const item of order.items ?? []) {
          const existing = itemCounts.get(item.itemId);
          itemCounts.set(item.itemId, { name: item.name, quantity: (existing?.quantity ?? 0) + item.quantity });
        }
      }
      const best = [...itemCounts.entries()].sort((a, b) => b[1].quantity - a[1].quantity)[0];
      response.bestSeller = best ? { itemId: best[0], name: best[1].name, quantitySold: best[1].quantity } : null;
    }
  }

  return response;
});

/**
 * getBusinessAnalytics (Phase 4, Section 2.5).
 *
 * Entirely gated behind canViewAdvancedAnalytics (Pro and Pro Plus only) —
 * the whole function rejects for Basic/Standard rather than gating
 * individual facets, matching the spec's "Backend enforces independently
 * of frontend" edge case. Computes what's derivable from existing order
 * data today (revenue trend, top customers, platform-vs-external);
 * facets that need dedicated tracking infrastructure that doesn't exist
 * yet (conversion funnel, storefront performance, customer source
 * breakdown) return an explicit dataPending marker rather than fabricated
 * numbers — per Section 11, "the underlying data computation for
 * analytics is a future phase," only the access-control gate is Phase 4.
 */
export const getBusinessAnalytics = https.onCall(async (request) => {
  checkAppCheck(request, "getBusinessAnalytics");
  const vendorId = await requireVendorId(request);
  const { limits: planLimits } = await resolveEffectivePlan(vendorId);

  if (!planLimits.canViewAdvancedAnalytics) {
    throw new https.HttpsError("permission-denied", "Business analytics is not available on your current plan.");
  }

  const filterRange = clampRange((request.data as { filterRange?: unknown } | undefined)?.filterRange, planLimits.dashboardFilterRange);
  const rangeStart = Timestamp.fromMillis(Date.now() - RANGE_MS[filterRange]);
  const ordersSnap = await db.collection("orders")
    .where("vendorId", "==", vendorId)
    .where("createdAt", ">=", rangeStart)
    .get();
  const orders = ordersSnap.docs.map((d) => d.data() as OrderDoc);
  const completed = orders.filter((o) => o.status === "completed");

  const revenueByDay = new Map<string, number>();
  for (const o of completed) {
    const createdAtMs = o.createdAt && "toMillis" in o.createdAt ? (o.createdAt as Timestamp).toMillis() : Date.now();
    const dayKey = new Date(createdAtMs).toISOString().slice(0, 10);
    revenueByDay.set(dayKey, (revenueByDay.get(dayKey) ?? 0) + (o.orderSnapshot?.total ?? 0));
  }
  const revenueTrend = [...revenueByDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, total]) => ({ date, total }));

  const spendByCustomer = new Map<string, number>();
  for (const o of completed) {
    spendByCustomer.set(o.customerId, (spendByCustomer.get(o.customerId) ?? 0) + (o.orderSnapshot?.total ?? 0));
  }
  /**
   * Repeat customers: how many ordered more than once, and what share of the
   * total that is. Counted on completed orders only — an abandoned request is
   * not a customer returning.
   */
  const ordersPerCustomer = new Map<string, number>();
  for (const o of completed) {
    if (o.orderSource !== "internal" || !o.customerId) continue;
    ordersPerCustomer.set(o.customerId, (ordersPerCustomer.get(o.customerId) ?? 0) + 1);
  }
  const distinctCustomers = ordersPerCustomer.size;
  const repeatCustomers = [...ordersPerCustomer.values()].filter((n) => n > 1).length;

  const repeatCustomerAnalytics = distinctCustomers === 0
    // No customers at all is not a zero percent repeat rate; it is nothing to
    // report. Saying "0% returned" to a vendor with no orders reads as failure
    // rather than as absence.
    ? { dataPending: true as const }
    : {
        distinctCustomers,
        repeatCustomers,
        repeatRatePercent: Math.round((repeatCustomers / distinctCustomers) * 100),
      };

  /**
   * Customer growth: first-time customers per day across the window, taken from
   * each customer's earliest order rather than from order dates, so a regular
   * is counted once on the day they first appeared.
   */
  const firstSeen = new Map<string, number>();
  for (const o of orders) {
    if (o.orderSource !== "internal" || !o.customerId) continue;
    const ms = o.createdAt && "toMillis" in o.createdAt ? (o.createdAt as Timestamp).toMillis() : Date.now();
    const existing = firstSeen.get(o.customerId);
    if (existing === undefined || ms < existing) firstSeen.set(o.customerId, ms);
  }
  const newByDay = new Map<string, number>();
  for (const ms of firstSeen.values()) {
    const day = new Date(ms).toISOString().slice(0, 10);
    newByDay.set(day, (newByDay.get(day) ?? 0) + 1);
  }
  const customerGrowth = firstSeen.size === 0
    ? { dataPending: true as const }
    : {
        totalCustomers: firstSeen.size,
        newCustomersByDay: [...newByDay.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, count]) => ({ date, count })),
      };

  const topCustomers = [...spendByCustomer.entries()].sort(([, a], [, b]) => b - a).slice(0, 10).map(([customerId, total]) => ({ customerId, total }));

  const internalCount = orders.filter((o) => o.orderSource === "internal").length;
  const externalCount = orders.filter((o) => o.orderSource === "external").length;

  return {
    success: true,
    planLimits,
    filterRange,
    revenueTrend,
    topCustomers,
    ordersBySource: { internal: internalCount, external: externalCount },
    platformVsExternalAnalytics: { internal: internalCount, external: externalCount },
    // Deferred to a future phase — see function doc comment.
    /**
     * Still pending, and honestly so. Both need storefront visit tracking,
     * which does not exist: there is no record of somebody opening a storefront
     * and not ordering. A conversion rate invented without it would be a
     * specific claim about the vendor's business with nothing behind it.
     */
    conversionFunnel: { dataPending: true },
    storefrontPerformance: { dataPending: true },

    /**
     * These two are computed now. Both come from orders, which the vendor
     * already has, so nothing needs to be tracked that is not already recorded.
     */
    customerGrowth,
    repeatCustomerAnalytics,
    customerSourceBreakdown: { dataPending: true },
  };
});
