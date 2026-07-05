import { ModerationAction, ModerationAppliesTo, ModerationCategory, ModerationSeverity } from "../types3";

/**
 * Default moderation rule set (P3-FB-021).
 *
 * This is a starting point, not a complete or permanent list — it is seeded
 * into Firestore (moderationRules) by seedDefaultModerationRules rather than
 * read directly from this file at runtime, so it can be edited in Firestore
 * once Phase 5 admin tooling exists without a redeploy.
 *
 * Deliberately conservative on ambiguous terms: Nigerian-English words with
 * legitimate everyday uses (yahoo, 419, aza, juju, ritual) stay at low/medium
 * severity with allow_flag, never block_message. Two entries deliberately
 * DEVIATE from a stricter classification that was requested, because
 * blocking them outright would break normal conversation:
 *   - "420" (bare number) — routinely appears in prices, addresses, times.
 *   - "loud" (bare word) — an ordinary adjective ("sorry, it's loud here").
 * Both are kept at medium/hold_for_review (visible to a reviewer, message
 * still sends) instead of critical/block_message. Everything else follows
 * the requested severity tiers as given.
 *
 * The `standalone: false` entries are payment/contact terms and bare
 * off-platform-channel names explicitly called out as normal the platform
 * commerce chatter — they never flag on their own, only when a genuine
 * off-platform-avoidance phrase is present in the same message (see
 * moderationEngine.ts's standalone-combination logic).
 *
 * `scoreOverride` is used for the PII/link-detection regex rules, whose
 * real-world risk doesn't track their block/flag severity — a shared phone
 * number never blocks a message, but should weigh more per the account-level
 * cumulative trust score than an ordinary low-severity insult would.
 */
export interface SeedRule {
  category: ModerationCategory;
  pattern: string;
  isRegex?: boolean;
  standalone?: boolean;
  severity: ModerationSeverity;
  action: ModerationAction;
  appliesTo: ModerationAppliesTo;
  scoreOverride?: number;
}

/**
 * Generates one rule per term, in both "chat" and "catalog" scopes, at the
 * same severity/action. Used for prohibited-item bare terms (weapons,
 * drugs) where the same word is exactly as unacceptable in a catalog
 * listing's name/description as it is in a chat message — a single
 * per-category term list here, rather than hand-duplicated entries, is
 * what actually guarantees the two scopes stay in sync (a manually
 * duplicated list previously missed several catalog-scope terms).
 */
function bothScopes(
  category: ModerationCategory, terms: string[], severity: ModerationSeverity, action: ModerationAction
): SeedRule[] {
  return terms.flatMap((pattern) => ([
    { category, pattern, severity, action, appliesTo: "chat" as ModerationAppliesTo },
    { category, pattern, severity, action, appliesTo: "catalog" as ModerationAppliesTo },
  ]));
}

const WEAPONS_TERMS = ["gun", "pistol", "rifle", "ak47", "ak-47", "shotgun", "firearm", "ammunition", "ammo", "bullet", "grenade", "explosive", "bomb", "ied", "silencer"];
const DRUGS_TERMS = ["cocaine", "crack", "heroin", "meth", "methamphetamine", "ecstasy", "mdma", "lsd", "opium", "fentanyl", "kush", "weed", "marijuana", "cannabis"];
const ILLEGAL_ITEMS_TERMS = ["fake id", "fake passport", "passport for sale", "forged certificate", "counterfeit passport", "counterfeit", "human organ", "live animal"];

export const DEFAULT_MODERATION_RULES: SeedRule[] = [
  ...bothScopes("weapons", WEAPONS_TERMS, "critical", "block_message"),
  ...bothScopes("drugs", DRUGS_TERMS, "critical", "block_message"),
  ...bothScopes("illegal_items", ILLEGAL_ITEMS_TERMS, "critical", "block_message"),

  // ── off_platform_ordering: standalone avoidance phrases (block) ────────
  { category: "off_platform_ordering", pattern: "pay outside the platform", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "don't use the platform", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "dont use the platform", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "order outside the app", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "message me on whatsapp to order", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "message me on whatsapp instead", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "whatsapp me to order", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "ignore the app", severity: "medium", action: "hold_for_review", appliesTo: "chat" },
  // Neutral payment/contact terms and bare channel names — never trigger
  // alone, only as corroborating evidence when a standalone phrase above
  // also matches in the same message.
  { category: "off_platform_ordering", pattern: "bank transfer", standalone: false, severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "proof of payment", standalone: false, severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "payment screenshot", standalone: false, severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "call me", standalone: false, severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "contact me", standalone: false, severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "phone me", standalone: false, severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "email me", standalone: false, severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "text me", standalone: false, severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "whatsapp", standalone: false, severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "instagram", standalone: false, severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "facebook", standalone: false, severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "off_platform_ordering", pattern: "telegram", standalone: false, severity: "low", action: "allow_flag", appliesTo: "chat" },

  // ── price_hiding — allow but flag, never block ──────────────────────────
  { category: "price_hiding", pattern: "dm for price", severity: "medium", action: "allow_flag", appliesTo: "chat" },
  { category: "price_hiding", pattern: "inbox for price", severity: "medium", action: "allow_flag", appliesTo: "chat" },
  { category: "price_hiding", pattern: "chat for price", severity: "medium", action: "allow_flag", appliesTo: "chat" },
  { category: "price_hiding", pattern: "message for price", severity: "medium", action: "allow_flag", appliesTo: "chat" },
  { category: "price_hiding", pattern: "call for price", severity: "medium", action: "allow_flag", appliesTo: "chat" },
  { category: "price_hiding", pattern: "whatsapp for price", severity: "medium", action: "allow_flag", appliesTo: "chat" },
  { category: "price_hiding", pattern: "price on whatsapp", severity: "medium", action: "allow_flag", appliesTo: "chat" },
  { category: "price_hiding", pattern: "price in dm", severity: "medium", action: "allow_flag", appliesTo: "chat" },

  // ── scams_fraud ─────────────────────────────────────────────────────────
  { category: "scams_fraud", pattern: "guaranteed returns", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "scams_fraud", pattern: "double your money", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "scams_fraud", pattern: "investment scheme", severity: "medium", action: "hold_for_review", appliesTo: "chat" },
  { category: "scams_fraud", pattern: "investment guaranteed", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "scams_fraud", pattern: "ponzi", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "scams_fraud", pattern: "mmm", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "scams_fraud", pattern: "flip cash", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "scams_fraud", pattern: "get rich quick", severity: "high", action: "block_message", appliesTo: "chat" },
  // Suspicious sales language — allow, flag, contribute to score only.
  { category: "scams_fraud", pattern: "urgent buyer", severity: "medium", action: "allow_flag", appliesTo: "chat" },
  { category: "scams_fraud", pattern: "urgent seller", severity: "medium", action: "allow_flag", appliesTo: "chat" },
  { category: "scams_fraud", pattern: "quick cash", severity: "medium", action: "allow_flag", appliesTo: "chat" },
  { category: "scams_fraud", pattern: "buyer only", severity: "medium", action: "allow_flag", appliesTo: "chat" },
  { category: "scams_fraud", pattern: "no refund", severity: "medium", action: "allow_flag", appliesTo: "chat" },
  { category: "scams_fraud", pattern: "non refundable", severity: "medium", action: "allow_flag", appliesTo: "chat" },

  // ── financial_scams (includes Nigerian slang) — allow, flag only ───────
  { category: "financial_scams", pattern: "yahoo", severity: "medium", action: "allow_flag", appliesTo: "chat" },
  { category: "financial_scams", pattern: "419", severity: "medium", action: "allow_flag", appliesTo: "chat" },
  { category: "financial_scams", pattern: "aza", severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "financial_scams", pattern: "wire money", severity: "medium", action: "allow_flag", appliesTo: "chat" },
  { category: "financial_scams", pattern: "ritual money", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "financial_scams", pattern: "blood money", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "financial_scams", pattern: "juju", severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "financial_scams", pattern: "ritual", severity: "low", action: "allow_flag", appliesTo: "chat" },

  // ── phishing_hacking / fraud (critical — always block) ──────────────────
  { category: "phishing_hacking", pattern: "send your otp", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "phishing_hacking", pattern: "share your pin", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "phishing_hacking", pattern: "verify your account here", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "phishing_hacking", pattern: "click this link to claim", severity: "high", action: "hold_for_review", appliesTo: "chat" },
  { category: "phishing_hacking", pattern: "stolen card", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "phishing_hacking", pattern: "credit card dump", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "phishing_hacking", pattern: "cvv", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "phishing_hacking", pattern: "carding", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "phishing_hacking", pattern: "bank login", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "phishing_hacking", pattern: "hack bank", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "phishing_hacking", pattern: "bank account for sale", severity: "critical", action: "block_message", appliesTo: "chat" },
  // "otp" bare is deliberately excluded from critical/block — the platform's own
  // email/phone verification flows legitimately reference "otp" in support
  // conversations ("my otp didn't arrive"). "send your otp" above already
  // catches the actual phishing pattern.

  // ── illegal_items (bare terms generated above; phrase-level chat-only
  // entries below — these read as conversation, not catalog listing names) ─
  { category: "illegal_items", pattern: "stolen goods", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "illegal_items", pattern: "fake documents", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "illegal_items", pattern: "live animal for sale", severity: "critical", action: "block_message", appliesTo: "chat" },

  // ── weapons (bare terms generated above; phrase-level chat-only entries
  // below) ─────────────────────────────────────────────────────────────────
  { category: "weapons", pattern: "buy a gun", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "weapons", pattern: "sell my gun", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "weapons", pattern: "ammunition for sale", severity: "critical", action: "block_message", appliesTo: "chat" },

  // ── drugs (bare terms generated above; phrase-level chat-only entries
  // below) ─────────────────────────────────────────────────────────────────
  { category: "drugs", pattern: "sell weed", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "drugs", pattern: "cocaine for sale", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "drugs", pattern: "buy drugs", severity: "high", action: "block_message", appliesTo: "chat" },
  // Deliberately downgraded from the requested critical/block — see file
  // header. "loud" is ordinary English; "420" routinely appears in prices,
  // addresses, and times, so both stay reviewable rather than block-worthy.
  { category: "drugs", pattern: "loud", severity: "medium", action: "hold_for_review", appliesTo: "chat" },
  { category: "drugs", pattern: "420", severity: "medium", action: "hold_for_review", appliesTo: "chat" },

  // ── adult_content (high — block + admin review) ─────────────────────────
  { category: "adult_content", pattern: "send nudes", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "adult_content", pattern: "nude pics", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "adult_content", pattern: "escort", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "adult_content", pattern: "hookup", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "adult_content", pattern: "hook up", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "adult_content", pattern: "sex service", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "adult_content", pattern: "onlyfans", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "adult_content", pattern: "porn", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "adult_content", pattern: "nudes", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "adult_content", pattern: "dildo", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "adult_content", pattern: "vibrator", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "adult_content", pattern: "escort", severity: "critical", action: "block_message", appliesTo: "catalog" },
  { category: "adult_content", pattern: "porn", severity: "critical", action: "block_message", appliesTo: "catalog" },

  // ── dangerous_medical_claims (high — block + admin review) ──────────────
  { category: "dangerous_medical_claims", pattern: "cures cancer", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "dangerous_medical_claims", pattern: "cure cancer", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "dangerous_medical_claims", pattern: "cure hiv", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "dangerous_medical_claims", pattern: "miracle cure", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "dangerous_medical_claims", pattern: "instant cure", severity: "high", action: "block_message", appliesTo: "chat" },
  { category: "dangerous_medical_claims", pattern: "abortion pills", severity: "high", action: "block_message", appliesTo: "chat" },

  // ── gambling ────────────────────────────────────────────────────────────
  { category: "gambling", pattern: "sports betting tips", severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "gambling", pattern: "guaranteed betting win", severity: "medium", action: "hold_for_review", appliesTo: "chat" },
  { category: "gambling", pattern: "gambling", severity: "critical", action: "block_message", appliesTo: "catalog" },
  { category: "gambling", pattern: "betting odds", severity: "critical", action: "block_message", appliesTo: "catalog" },

  // ── raw_restricted_food ─────────────────────────────────────────────────
  { category: "raw_restricted_food", pattern: "raw bushmeat", severity: "high", action: "hold_for_review", appliesTo: "chat" },
  { category: "raw_restricted_food", pattern: "endangered species meat", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "raw_restricted_food", pattern: "raw meat", severity: "critical", action: "block_message", appliesTo: "catalog" },
  { category: "raw_restricted_food", pattern: "raw poultry", severity: "critical", action: "block_message", appliesTo: "catalog" },
  { category: "raw_restricted_food", pattern: "raw chicken", severity: "critical", action: "block_message", appliesTo: "catalog" },
  { category: "raw_restricted_food", pattern: "raw fish", severity: "critical", action: "block_message", appliesTo: "catalog" },

  // ── abusive_language (low — monitor only) ───────────────────────────────
  { category: "abusive_language", pattern: "mumu", severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "abusive_language", pattern: "ode", severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "abusive_language", pattern: "agbaya", severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "abusive_language", pattern: "thunder fire you", severity: "medium", action: "hold_for_review", appliesTo: "chat" },
  { category: "abusive_language", pattern: "stupid fool", severity: "medium", action: "hold_for_review", appliesTo: "chat" },
  { category: "abusive_language", pattern: "idiot", severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "abusive_language", pattern: "stupid", severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "abusive_language", pattern: "fool", severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "abusive_language", pattern: "bastard", severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "abusive_language", pattern: "useless", severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "abusive_language", pattern: "wicked", severity: "low", action: "allow_flag", appliesTo: "chat" },
  { category: "abusive_language", pattern: "animal", severity: "low", action: "allow_flag", appliesTo: "chat" },

  // ── child_exploitation (critical — always block, never enumerated
  // beyond the obvious terms named in the moderation spec) ────────────────
  { category: "child_exploitation", pattern: "child porn", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "child_exploitation", pattern: "\\bcp\\b", isRegex: true, severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "child_exploitation", pattern: "underage sex", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "child_exploitation", pattern: "child porn", severity: "critical", action: "block_message", appliesTo: "catalog" },
  { category: "child_exploitation", pattern: "underage sex", severity: "critical", action: "block_message", appliesTo: "catalog" },

  // ── terrorism (critical — always block) ─────────────────────────────────
  { category: "terrorism", pattern: "isis", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "terrorism", pattern: "terrorist", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "terrorism", pattern: "bomb making", severity: "critical", action: "block_message", appliesTo: "chat" },
  { category: "terrorism", pattern: "explosive guide", severity: "critical", action: "block_message", appliesTo: "chat" },

  // ── off_platform_ordering: PII / off-platform link detection ───────────
  // Never block on their own — an ordinary phone number or link isn't
  // evidence of wrongdoing by itself, but it is a materially higher-risk
  // signal than a plain word, hence the elevated scoreOverride values.
  {
    category: "off_platform_ordering", pattern: "(\\+?\\d[\\d\\s-]{7,}\\d)", isRegex: true,
    severity: "medium", action: "allow_flag", appliesTo: "chat", scoreOverride: 15,
  },
  {
    category: "off_platform_ordering", pattern: "(wa\\.me\\/|chat\\.whatsapp)", isRegex: true,
    severity: "medium", action: "allow_flag", appliesTo: "chat", scoreOverride: 20,
  },
  {
    category: "off_platform_ordering", pattern: "t\\.me\\/", isRegex: true,
    severity: "medium", action: "allow_flag", appliesTo: "chat", scoreOverride: 20,
  },
  {
    category: "off_platform_ordering", pattern: "[\\w.+-]+@[\\w-]+\\.[a-z]{2,}", isRegex: true,
    severity: "low", action: "allow_flag", appliesTo: "chat", scoreOverride: 10,
  },
  {
    category: "off_platform_ordering", pattern: "(https?:\\/\\/|www\\.)", isRegex: true,
    severity: "low", action: "allow_flag", appliesTo: "chat", scoreOverride: 10,
  },
  {
    category: "off_platform_ordering", pattern: "@[a-z0-9_.]{2,30}", isRegex: true,
    severity: "low", action: "allow_flag", appliesTo: "chat", scoreOverride: 5,
  },
];

/** Deterministic ruleId so re-seeding upserts rather than duplicates.
 * Includes appliesTo — the same pattern text is deliberately seeded twice
 * under both "chat" and "catalog" for several categories above, and those
 * must land as two distinct rules, not overwrite one another. */
export function ruleIdFor(rule: SeedRule): string {
  const slug = rule.pattern
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${rule.category}__${rule.appliesTo}__${slug}`;
}
