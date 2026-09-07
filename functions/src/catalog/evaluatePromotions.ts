import { db } from "../admin";
import { PromotionDoc } from "../types2";

/**
 * Server-side port of the mobile app's mock evaluation logic
 * (mocks/promotionsData.ts evaluateSinglePromo / evaluatePromotions),
 * kept behaviorally identical so a vendor's promotion behaves the same
 * once the mobile app is wired to this instead of its local mock. Only
 * "single" stacking (best-discount-wins, one promotion per order) is
 * implemented — the mobile mock's "delivery_only"/"advanced" stacking
 * modes have no vendor-facing way to configure them yet, so building
 * that now would be enforcing a setting nobody can set.
 */

export interface PromotionEvaluationResult {
  promotionId: string;
  title: string;
  discountAmount: number;
}

function isWithinDateRange(promo: PromotionDoc, now: Date): boolean {
  return new Date(promo.startDate) <= now && new Date(promo.endDate) >= now;
}

function evaluateSingle(
  promo: PromotionDoc,
  subtotal: number,
  cartItemIds: string[],
  cartItemQuantities: Record<string, number>
): { eligible: boolean; discountAmount: number } {
  switch (promo.type) {
    case "percentage": {
      if (subtotal < promo.minimumOrder) return { eligible: false, discountAmount: 0 };
      let discount = Math.round(subtotal * (promo.discountValue / 100));
      if (promo.maxDiscount && discount > promo.maxDiscount) discount = promo.maxDiscount;
      return { eligible: true, discountAmount: discount };
    }
    case "flat": {
      if (subtotal < promo.minimumOrder) return { eligible: false, discountAmount: 0 };
      return { eligible: true, discountAmount: Math.min(promo.discountValue, subtotal) };
    }
    case "free_item": {
      // No line-item-level discount today — the free item's value isn't
      // deducted from the cart total, matching the mobile mock exactly
      // (discountAmount: 0 there too; the "free" item is a fulfillment
      // note, not a price adjustment).
      return { eligible: subtotal >= promo.minimumOrder, discountAmount: 0 };
    }
    case "bogo": {
      const bogoItemIds = promo.applicableItemIds ?? [];
      const bogoQty = bogoItemIds.reduce((sum, id) => sum + (cartItemQuantities[id] ?? 0), 0);
      const hasBogoItem = bogoItemIds.some((id) => cartItemIds.includes(id));
      return { eligible: hasBogoItem && bogoQty >= 2, discountAmount: 0 };
    }
    case "free_delivery": {
      return { eligible: subtotal >= promo.minimumOrder, discountAmount: 0 };
    }
    default:
      return { eligible: false, discountAmount: 0 };
  }
}

/**
 * Evaluates a vendor's active, in-date-range promotions against a priced
 * cart and returns the single best-discount-value one, if any qualify.
 * Called from repriceCart — this is the backend's actual pricing
 * decision, not a display-only check; the mobile mock version becomes
 * redundant once the mobile app is wired to real carts.
 */
export async function evaluateBestPromotion(
  vendorId: string,
  subtotal: number,
  cartItemIds: string[],
  cartItemQuantities: Record<string, number>
): Promise<PromotionEvaluationResult | null> {
  const now = new Date();
  const snap = await db
    .collection("vendors").doc(vendorId).collection("promotions")
    .where("active", "==", true)
    .get();

  let best: PromotionEvaluationResult | null = null;
  for (const doc of snap.docs) {
    const promo = doc.data() as PromotionDoc;
    if (!isWithinDateRange(promo, now)) continue;
    const { eligible, discountAmount } = evaluateSingle(promo, subtotal, cartItemIds, cartItemQuantities);
    if (!eligible) continue;
    if (!best || discountAmount > best.discountAmount) {
      best = { promotionId: promo.promotionId, title: promo.title, discountAmount };
    }
  }
  return best;
}
