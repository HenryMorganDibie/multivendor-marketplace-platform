import { https } from "firebase-functions/v2";
import { db, Timestamp } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { OrderDoc } from "../types2";
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
  const todayRevenue = todayOrders
    .filter((o) => o.status === "completed")
    .reduce((sum, o) => sum + (o.orderSnapshot?.total ?? 0), 0);
  const upcomingOrders = todayOrders.filter((o) => ["accepted", "confirmed", "in_progress"].includes(o.status)).length;

  const response: Record<string, unknown> = {
    success: true,
    planLimits,
    filterRange,
    ordersToday,
    pendingOrders,
    todayRevenue,
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
    conversionFunnel: { dataPending: true },
    storefrontPerformance: { dataPending: true },
    customerGrowth: { dataPending: true },
    repeatCustomerAnalytics: { dataPending: true },
    customerSourceBreakdown: { dataPending: true },
  };
});
