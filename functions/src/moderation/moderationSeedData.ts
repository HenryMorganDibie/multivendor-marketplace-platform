import { ModerationAction, ModerationAppliesTo, ModerationCategory, ModerationSeverity } from "../types3";

/**
 * Default moderation rule set (P3-FB-021).
 *
 * This is a starting point, not a complete or permanent list — it is seeded
 * into Firestore (moderationRules) by seedDefaultModerationRules rather than
 * read directly from this file at runtime, so it can be edited in Firestore
 * once Phase 5 admin tooling exists without a redeploy.
 *
 * Deliberately conservative: ambiguous Nigerian-English terms (yahoo, 419,
 * aza, juju, ritual) are kept at low/medium severity with allow_flag or
 * hold_for_review rather than block_message, since these words have
 * legitimate everyday uses and the goal here is visibility for a future
 * human reviewer, not an aggressive auto-ban. The `standalone: false`
 * entries are the payment/contact terms explicitly called out as normal
 * the platform commerce chatter — they must never flag on their own, only when
 * a genuine off-platform-avoidance phrase is present in the same message.
 */
export interface SeedRule {
  category: ModerationCategory;
  pattern: string;
  isRegex?: boolean;
  standalone?: boolean;
  severity: ModerationSeverity;
  action: ModerationAction;
  appliesTo: ModerationAppliesTo;
}

export const DEFAULT_MODERATION_RULES: SeedRule[] = [
  // ── off_platform_ordering ──────────────────────────────────────────────
  { category: "off_platform_ordering", pattern: "pay outside the platform", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "don't use the platform", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "dont use the platform", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "order outside the app", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "message me on whatsapp to order", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "whatsapp me to order", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "ignore the app", severity: "medium", action: "hold_for_review", appliesTo: "chat" },
  // Neutral payment/contact terms — never trigger alone, only as
  // corroborating evidence when a standalone phrase above also matches.
  { category: "off_platform_ordering", pattern: "bank transfer", standalone: false, severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "proof of payment", standalone: false, severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "payment screenshot", standalone: false, severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "call me", standalone: false, severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "contact me", standalone: false, severity: "low", action: "allow_flag", appliesTo: "chat" },

  // ── price_hiding ────────────────────────────────────────────────────────
  { category: "price_hiding", pattern: "dm for price", severity: "medium", action: "hold_for_review", appliesTo: "chat" },
  { category: "price_hiding", pattern: "price on whatsapp", severity: "medium", action: "hold_for_review", appliesTo: "chat" },
  { category: "price_hiding", pattern: "price in dm", severity: "medium", action: "hold_for_review", appliesTo: "chat" },

  // ── scams_fraud ─────────────────────────────────────────────────────────
  { category: "scams_fraud", pattern: "guaranteed returns", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "scams_fraud", pattern: "double your money", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "scams_fraud", pattern: "investment scheme", severity: "medium", action: "hold_for_review", appliesTo: "chat" },

  // ── financial_scams (includes Nigerian slang) ──────────────────────────
  { category: "financial_scams", pattern: "yahoo", severity: "medium", action: "hold_for_review", appliesTo: "chat" },
  { category: "financial_scams", pattern: "419", severity: "medium", action: "hold_for_review", appliesTo: "chat" },
  { category: "financial_scams", pattern: "aza", severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "financial_scams", pattern: "ritual money", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "financial_scams", pattern: "blood money", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "financial_scams", pattern: "juju", severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "financial_scams", pattern: "ritual", severity: "low", action: "allow_flag", appliesTo: "chat" },

  // ── phishing_hacking ────────────────────────────────────────────────────
  { category: "phishing_hacking", pattern: "send your otp", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "phishing_hacking", pattern: "share your pin", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "phishing_hacking", pattern: "verify your account here", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "phishing_hacking", pattern: "click this link to claim", severity: "high", action: "hold_for_review", appliesTo: "chat" },

  // ── illegal_items ───────────────────────────────────────────────────────
  { category: "illegal_items", pattern: "stolen goods", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "illegal_items", pattern: "fake documents", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "illegal_items", pattern: "counterfeit passport", severity: "critical", action: "block_message", appliesTo: "chat" },

  // ── weapons ─────────────────────────────────────────────────────────────
  { category: "weapons", pattern: "buy a gun", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "weapons", pattern: "sell my gun", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "weapons", pattern: "ammunition for sale", severity: "critical", action: "block_message", appliesTo: "chat" },

  // ── drugs ───────────────────────────────────────────────────────────────
  { category: "drugs", pattern: "sell weed", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "drugs", pattern: "cocaine for sale", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "drugs", pattern: "buy drugs", severity: "high", action: "block_message", appliesTo: "chat" },

  // ── adult_content ───────────────────────────────────────────────────────
  { category: "adult_content", pattern: "send nudes", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "adult_content", pattern: "nude pics", severity: "high", action: "block_message", appliesTo: "chat" },

  // ── dangerous_medical_claims ────────────────────────────────────────────
  { category: "dangerous_medical_claims", pattern: "cures cancer", severity: "high", action: "hold_for_review", appliesTo: "chat" },
  { category: "dangerous_medical_claims", pattern: "miracle cure", severity: "medium", action: "hold_for_review", appliesTo: "chat" },

  // ── gambling ────────────────────────────────────────────────────────────
  { category: "gambling", pattern: "sports betting tips", severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "gambling", pattern: "guaranteed betting win", severity: "medium", action: "hold_for_review", appliesTo: "chat" },

  // ── raw_restricted_food ─────────────────────────────────────────────────
  { category: "raw_restricted_food", pattern: "raw bushmeat", severity: "high", action: "hold_for_review", appliesTo: "chat" },
  { category: "raw_restricted_food", pattern: "endangered species meat", severity: "critical", action: "block_message", appliesTo: "chat" },

  // ── abusive_language (includes Nigerian slang) ─────────────────────────
  { category: "abusive_language", pattern: "mumu", severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "abusive_language", pattern: "ode", severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "abusive_language", pattern: "agbaya", severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "abusive_language", pattern: "thunder fire you", severity: "medium", action: "hold_for_review", appliesTo: "chat" },
  { category: "abusive_language", pattern: "stupid fool", severity: "medium", action: "hold_for_review", appliesTo: "chat" },
];

/** Deterministic ruleId so re-seeding upserts rather than duplicates. */
export function ruleIdFor(rule: SeedRule): string {
  const slug = rule.pattern
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${rule.category}__${slug}`;
}
