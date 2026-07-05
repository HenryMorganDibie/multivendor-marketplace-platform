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
  low: 2,
  medium: 5,
  high: 10,
  critical: 100,
};

// Per-user cumulative trust-score thresholds. Escalation only — an admin
// must review and reset via reviewModerationRestriction, never automatic.
const SCORE_THRESHOLD_WARN = 20;
const SCORE_THRESHOLD_RESTRICT = 50;
const SCORE_THRESHOLD_SUSPEND = 100;

const SEVERITY_RANK: Record<ModerationSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

// action priority when multiple rules match the same message — the most
// restrictive configured action wins, never an average or a guess.
const ACTION_PRIORITY: ModerationAction[] = ["block_message", "hold_for_review", "admin_alert", "allow_flag"];

export function normalizeText(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deliberately uncached. A module-level cache here would be a per-process,
 * per-Cloud-Functions-instance snapshot — the emulator (and production,
 * across multiple instances) does not guarantee the instance that just
 * seeded/edited a rule is the same one serving the next request, so a
 * "clear the cache" call after a rules edit only ever clears one
 * instance's copy. Rules changes are rare (an admin action, not a hot
 * path), so a plain Firestore read on every check is the correct
 * trade — always-consistent over marginally faster.
 */
async function loadActiveRules(appliesTo: ModerationAppliesTo): Promise<ModerationRuleDoc[]> {
  const snap = await db.collection("moderationRules")
    .where("appliesTo", "==", appliesTo)
    .where("isActive", "==", true)
    .get();
  return snap.docs.map((d) => d.data() as ModerationRuleDoc);
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

  const score = qualifying.reduce((sum, r) => sum + (r.scoreOverride ?? SEVERITY_WEIGHT[r.severity]), 0);
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

// ─── Per-user cumulative trust score ────────────────────────────────────────
//
// A single bad word should never suspend an account — but a pattern of
// them should surface for review. This reuses the existing AccountStatus
// enum (types.ts) rather than a parallel status field, so every access
// check already keyed off accountStatus elsewhere in the codebase
// automatically respects it too.

export interface UserModerationCheck {
  blocked: boolean; // accountStatus === "banned"
  restricted: boolean; // accountStatus === "frozen"
  reason: string | null;
}

/** Call before allowing a user to send a chat message, list a catalog item,
 * etc. Read-only — does not itself change anything. */
export async function checkUserModerationRestriction(uid: string): Promise<UserModerationCheck> {
  const snap = await db.collection("users").doc(uid).get();
  const status = snap.data()?.accountStatus as string | undefined;
  const reason = (snap.data()?.moderationStatusReason as string | undefined) ?? null;
  return {
    blocked: status === "banned",
    restricted: status === "frozen",
    reason,
  };
}

/**
 * Increments a user's cumulative moderation score and escalates
 * accountStatus at the 50 (frozen / temporary restriction) and 100
 * (banned / auto-suspension pending review) thresholds. Escalation only —
 * never downgrades a status here; that is an explicit admin action
 * (reviewModerationRestriction). Runs in a transaction so concurrent
 * flagged messages from the same user can't race past a threshold
 * uncounted.
 */
export async function applyUserModerationScore(uid: string, scoreDelta: number): Promise<void> {
  if (scoreDelta <= 0) return;

  const userRef = db.collection("users").doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) return; // system/admin actors, or a race with account deletion

    const data = snap.data()!;
    const currentStatus = data.accountStatus as string;
    // Already the terminal state — still record the score for the audit
    // trail, but there is no further status to escalate to.
    if (currentStatus === "banned") {
      tx.update(userRef, { moderationScore: FieldValue.increment(scoreDelta), updatedAt: FieldValue.serverTimestamp() });
      return;
    }

    const newScore = (typeof data.moderationScore === "number" ? data.moderationScore : 0) + scoreDelta;
    const updates: Record<string, unknown> = {
      moderationScore: newScore,
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (newScore >= SCORE_THRESHOLD_SUSPEND) {
      updates.accountStatus = "banned";
      updates.moderationBannedAt = FieldValue.serverTimestamp();
      updates.moderationStatusReason = `Cumulative moderation score reached ${newScore} (threshold ${SCORE_THRESHOLD_SUSPEND}).`;
    } else if (newScore >= SCORE_THRESHOLD_RESTRICT && currentStatus !== "frozen") {
      updates.accountStatus = "frozen";
      updates.moderationRestrictedAt = FieldValue.serverTimestamp();
      updates.moderationStatusReason = `Cumulative moderation score reached ${newScore} (threshold ${SCORE_THRESHOLD_RESTRICT}).`;
    } else if (newScore >= SCORE_THRESHOLD_WARN && !data.moderationWarnedAt) {
      updates.moderationWarnedAt = FieldValue.serverTimestamp();
    }

    tx.update(userRef, updates);
  });
}
