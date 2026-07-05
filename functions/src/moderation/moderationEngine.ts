import * as crypto from "crypto";
import { db, FieldValue } from "../admin";
import {
  ModerationAction,
  ModerationAppliesTo,
  ModerationCategory,
  ModerationEventDoc,
  ModerationRuleDoc,
  ModerationSeverity,
} from "../types3";

/**
 * Rule-based moderation engine (P3-FB-021).
 *
 * A FLAGGING system first, not an aggressive hard-ban system: most matches
 * result in the message being saved with a moderationStatus, not rejected.
 * Only rules explicitly configured with action: "block_message" (typically
 * high/critical severity) stop a message from sending. Everything here is
 * driven by Firestore-stored rules (moderationRules), never hardcoded
 * pattern lists baked into a function, so the rule set can be tuned without
 * a redeploy once Phase 5 admin tooling exists to edit it directly.
 */

const SEVERITY_WEIGHT: Record<ModerationSeverity, number> = {
  low: 1,
  medium: 3,
  high: 7,
  critical: 12,
};

const SEVERITY_RANK: Record<ModerationSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

// action priority when multiple rules match the same message — the most
// restrictive configured action wins, never an average or a guess.
const ACTION_PRIORITY: ModerationAction[] = ["block_message", "hold_for_review", "admin_alert", "allow_flag"];

let cachedRules: { rules: ModerationRuleDoc[]; appliesTo: ModerationAppliesTo; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

/** Exposed for tests only, to force a fresh Firestore read after seeding/editing rules. */
export function clearModerationRuleCache(): void {
  cachedRules = null;
}

export function normalizeText(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

async function loadActiveRules(appliesTo: ModerationAppliesTo): Promise<ModerationRuleDoc[]> {
  if (cachedRules && cachedRules.appliesTo === appliesTo && cachedRules.expiresAt > Date.now()) {
    return cachedRules.rules;
  }
  const snap = await db.collection("moderationRules")
    .where("appliesTo", "==", appliesTo)
    .where("isActive", "==", true)
    .get();
  const rules = snap.docs.map((d) => d.data() as ModerationRuleDoc);
  cachedRules = { rules, appliesTo, expiresAt: Date.now() + CACHE_TTL_MS };
  return rules;
}

function ruleMatches(normalizedText: string, rule: ModerationRuleDoc): boolean {
  if (rule.isRegex) {
    try {
      return new RegExp(rule.pattern, "i").test(normalizedText);
    } catch {
      return false; // a malformed stored regex must never crash message sending
    }
  }
  return normalizedText.includes(rule.pattern.toLowerCase());
}

export interface ModerationResult {
  status: "clean" | "flagged" | "blocked" | "needs_review";
  score: number;
  action: ModerationAction | null;
  severity: ModerationSeverity | null;
  category: ModerationCategory | null;
  matchedRuleIds: string[];
  matchedRules: ModerationRuleDoc[];
  blocked: boolean;
}

const CLEAN_RESULT: ModerationResult = {
  status: "clean", score: 0, action: null, severity: null, category: null, matchedRuleIds: [], matchedRules: [], blocked: false,
};

/**
 * runModerationCheck — the core decision function. Call this before
 * persisting any user-authored text; never write the message first.
 */
export async function runModerationCheck(
  text: string,
  appliesTo: ModerationAppliesTo
): Promise<ModerationResult> {
  const normalized = normalizeText(text);
  if (!normalized) return CLEAN_RESULT;

  const rules = await loadActiveRules(appliesTo);
  const allMatches = rules.filter((r) => ruleMatches(normalized, r));
  if (allMatches.length === 0) return CLEAN_RESULT;

  const standaloneMatches = allMatches.filter((r) => r.standalone !== false);
  if (standaloneMatches.length === 0) {
    // Only weak-signal (standalone:false) terms matched — e.g. "bank
    // transfer" with no off-platform-avoidance phrase alongside it. This is
    // normal the platform commerce chatter and must not be flagged at all.
    return CLEAN_RESULT;
  }

  // Qualifying matches = every standalone match, plus every weak-signal
  // match, now that at least one standalone match justifies counting them.
  const qualifying = allMatches;

  const score = qualifying.reduce((sum, r) => sum + SEVERITY_WEIGHT[r.severity], 0);
  const topSeverity = qualifying.reduce<ModerationSeverity>(
    (worst, r) => (SEVERITY_RANK[r.severity] > SEVERITY_RANK[worst] ? r.severity : worst),
    "low"
  );
  const topAction = ACTION_PRIORITY.find((a) => qualifying.some((r) => r.action === a)) ?? "allow_flag";
  const topCategory = qualifying.find((r) => r.severity === topSeverity)?.category ?? qualifying[0].category;
  const matchedRuleIds = qualifying.map((r) => r.ruleId);

  const status =
    topAction === "block_message" ? "blocked" :
    topAction === "hold_for_review" ? "needs_review" :
    "flagged"; // allow_flag and admin_alert both surface as "flagged" on the message itself

  return {
    status,
    score,
    action: topAction,
    severity: topSeverity,
    category: topCategory,
    matchedRuleIds,
    matchedRules: qualifying,
    blocked: topAction === "block_message",
  };
}

const MAX_SNIPPET_LENGTH = 160;

/** Masks every matched rule's literal pattern, then truncates. Substring
 * rules only — a stored regex is never echoed back into a redacted
 * snippet since its match span isn't cheaply recoverable here. */
function redactSnippet(normalizedText: string, matchedRules: ModerationRuleDoc[]): string {
  let redacted = normalizedText;
  for (const rule of matchedRules) {
    if (rule.isRegex) continue;
    const escaped = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    redacted = redacted.replace(new RegExp(escaped, "gi"), "[redacted]");
  }
  return redacted.length > MAX_SNIPPET_LENGTH
    ? `${redacted.slice(0, MAX_SNIPPET_LENGTH)}…`
    : redacted;
}

interface RecordModerationEventParams {
  actorUid: string;
  actorRole: "customer" | "vendor" | "admin" | "system";
  vendorId?: string | null;
  customerId?: string | null;
  chatId?: string | null;
  messageId?: string | null;
  rawText: string;
  result: ModerationResult;
}

/** Writes a moderationEvents record. Never logs the raw message text. */
export async function recordModerationEvent(params: RecordModerationEventParams): Promise<void> {
  if (!params.result.category || !params.result.action || !params.result.severity) return;

  const normalized = normalizeText(params.rawText);
  const eventRef = db.collection("moderationEvents").doc();
  const event: ModerationEventDoc = {
    eventId: eventRef.id,
    actorUid: params.actorUid,
    actorRole: params.actorRole,
    vendorId: params.vendorId ?? null,
    customerId: params.customerId ?? null,
    chatId: params.chatId ?? null,
    messageId: params.messageId ?? null,
    category: params.result.category,
    matchedRuleIds: params.result.matchedRuleIds,
    severity: params.result.severity,
    actionTaken: params.result.action,
    originalTextHash: crypto.createHash("sha256").update(normalized).digest("hex"),
    textSnippetRedacted: redactSnippet(normalized, params.result.matchedRules),
    createdAt: FieldValue.serverTimestamp(),
  };
  await eventRef.set(event);
}
