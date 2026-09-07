import { https } from "firebase-functions/v2";
import { db, Timestamp } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { resolveEffectivePlan } from "../subscriptions/resolveEffectivePlan";
import { OrderDoc } from "../types2";

/**
 * The figures behind the dashboard insight carousel.
 *
 * Every one of these was invented before: newCustomersThisWeek was the literal
 * number 3, lowStockCount was 2, avgResponseMinutes was 8, all hardcoded at the
 * call site. An account with no customers at all was told it had gained three
 * this week.
 *
 * They are computed here instead, and anything that cannot be computed honestly
 * is left out rather than filled in. The carousel already guards every insight
 * behind a presence check, so an absent figure means that card does not render
 * — which is the correct behaviour for a vendor who has no data yet, and far
 * better than a confident wrong number.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const getDashboardInsights = https.onCall(async (request) => {
  checkAppCheck(request, "getDashboardInsights");

  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string | undefined;
  if (!vendorId) {
    throw new https.HttpsError("failed-precondition", "Vendor ID could not be determined.");
  }

  const { limits } = await resolveEffectivePlan(vendorId);

  const weekAgo = Timestamp.fromMillis(Date.now() - WEEK_MS);

  // Bounded, not "every order this vendor has ever had": unbounded here read a
  // vendor's full order history on every dashboard open, invisible at two
  // hundred orders and a slow, expensive read well before fifty thousand. The
  // insights below only need "was this customer seen before this week" and
  // "is there an old unpaid order", both of which a recent window answers
  // correctly for the overwhelming majority of vendors — a customer or an
  // unpaid order older than this is stale enough that missing it here (a
  // dashboard hint, not a financial record) is the right trade, not a bug.
  const RECENT_ORDERS_LIMIT = 500;

  const [ordersSnap, itemsSnap] = await Promise.all([
    db
      .collection("orders")
      .where("vendorId", "==", vendorId)
      .orderBy("createdAt", "desc")
      .limit(RECENT_ORDERS_LIMIT)
      .get(),
    db.collection("vendors").doc(vendorId).collection("catalogItems").get(),
  ]);

  const orders = ordersSnap.docs.map((d) => d.data() as OrderDoc);

  // Orders the vendor has accepted but not been paid for. Only internal orders
  // count: an external one was recorded by the vendor after the fact, so there
  // is nothing for them to chase.
  const pendingPaymentCount = orders.filter(
    (o) =>
      o.orderSource === "internal" &&
      o.paymentStatus === "UNPAID" &&
      ["accepted", "confirmed", "in_progress"].includes(o.status)
  ).length;

  // Distinct customers seen this week, not order count: five orders from one
  // regular is not five new customers.
  const customersThisWeek = new Set(
    orders
      .filter((o) => {
        const created = o.createdAt as Timestamp | undefined;
        return (
          o.orderSource === "internal" &&
          created &&
          created.toMillis() >= weekAgo.toMillis()
        );
      })
      .map((o) => o.customerId)
      .filter(Boolean)
  );

  // Anyone who ordered before this week is not new.
  const earlierCustomers = new Set(
    orders
      .filter((o) => {
        const created = o.createdAt as Timestamp | undefined;
        return created && created.toMillis() < weekAgo.toMillis();
      })
      .map((o) => o.customerId)
      .filter(Boolean)
  );

  const newCustomersThisWeek = [...customersThisWeek].filter(
    (id) => !earlierCustomers.has(id)
  ).length;

  // Only items that actually track stock can be low on it. An item with
  // tracking off has no quantity to be low.
  const lowStockCount = itemsSnap.docs.filter((d) => {
    const item = d.data();
    if (item.trackInventory !== true) return false;
    const threshold = (item.lowStockThreshold as number | null) ?? 5;
    const quantity = (item.inventoryQuantity as number) ?? 0;
    return quantity > 0 && quantity <= threshold;
  }).length;

  const outOfStockCount = itemsSnap.docs.filter((d) => {
    const item = d.data();
    return item.trackInventory === true && ((item.inventoryQuantity as number) ?? 0) <= 0;
  }).length;

  // Best seller by units actually sold. orderCount is maintained server-side on
  // completion and is not writable by a vendor, so it cannot be inflated.
  const sold = itemsSnap.docs
    .map((d) => ({ name: d.data().name as string, count: (d.data().orderCount as number) ?? 0 }))
    .filter((i) => i.count > 0)
    .sort((a, b) => b.count - a.count);

  const bestSeller = sold[0] ?? null;

  return {
    success: true,

    pendingPaymentCount,
    // Null rather than zero when there is nothing to report: the carousel
    // guards on presence, so null hides the card while zero would render
    // "0 new customers this week", which is noise.
    newCustomersThisWeek: newCustomersThisWeek > 0 ? newCustomersThisWeek : null,
    lowStockCount: lowStockCount > 0 ? lowStockCount : null,
    outOfStockCount: outOfStockCount > 0 ? outOfStockCount : null,

    bestSellerName: bestSeller?.name ?? null,
    bestSellerCount: bestSeller?.count ?? null,

    /**
     * Average reply time is deliberately absent.
     *
     * Computing it honestly needs per-message timestamps paired into
     * customer-asked and vendor-answered, which the chat documents do not carry
     * in a form that can be read cheaply here. It was previously the hardcoded
     * number 8. Returning null hides the card, which is the truthful answer
     * until the data exists.
     */
    avgResponseMinutes: null,

    // The dashboard needs these to gate its own widgets. The backend already
    // decides them; sending them means the client stops guessing.
    canViewBestSellerWidget: limits.canViewBestSellerWidget,
    canViewRevenueCard: limits.canViewRevenueCard,
    canViewAdvancedAnalytics: limits.canViewAdvancedAnalytics,
  };
});
