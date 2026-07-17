import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { assertAdmin } from "../utils/adminAuth";
import { enforceRateLimit } from "../subscriptions/rateLimit";
import { SiteContentDoc, SiteContentNode, SiteContentSectionContent } from "../types4";

/**
 * CMS layer — LANDING_PAGE_CMS_VENDOR_PORTAL_MAPPING.md Section 2.
 *
 * siteContent/{sectionId} is Admin-SDK-only in firestore.rules (allow read,
 * write: if false). The browser never reads or writes it directly — every
 * path goes through one of the three callables below. This is what
 * guarantees "public visitors only ever receive published content" (2.1)
 * without relying on the frontend to remember not to render draftContent.
 */

const SITE_CONTENT_SECTION_IDS = [
  "home",
  "features",
  "vendors",
  "customers",
  "faq",
  "about",
  "privacy-policy",
  "terms-of-service",
  "vendor-terms",
  "customer-terms",
  "cookie-policy",
  "acceptable-use-policy",
] as const;

const LEGAL_SECTION_IDS = new Set([
  "privacy-policy",
  "terms-of-service",
  "vendor-terms",
  "customer-terms",
  "cookie-policy",
  "acceptable-use-policy",
]);

const ALLOWED_URL_SCHEMES = ["https:", "mailto:", "tel:"];

function assertSafeHref(href: unknown): string {
  if (typeof href !== "string" || !href) {
    throw new https.HttpsError("invalid-argument", "Link href must be a non-empty string.");
  }
  const lower = href.trim().toLowerCase();
  const okScheme = ALLOWED_URL_SCHEMES.some((scheme) => lower.startsWith(scheme));
  if (!okScheme) {
    throw new https.HttpsError("invalid-argument", "Link href must use https:, mailto:, or tel:.");
  }
  return href;
}

function assertSafeText(text: unknown): string {
  if (typeof text !== "string") {
    throw new https.HttpsError("invalid-argument", "Text fields must be strings.");
  }
  if (/<script|<iframe|javascript:|on\w+\s*=/i.test(text)) {
    throw new https.HttpsError("invalid-argument", "Text contains disallowed markup.");
  }
  return text;
}

function validateNode(raw: unknown): SiteContentNode {
  if (typeof raw !== "object" || raw === null || !("type" in raw)) {
    throw new https.HttpsError("invalid-argument", "Each content node requires a type.");
  }
  const node = raw as Record<string, unknown>;
  switch (node.type) {
    case "heading": {
      const level = Number(node.level);
      if (![1, 2, 3].includes(level)) {
        throw new https.HttpsError("invalid-argument", "Heading level must be 1, 2, or 3.");
      }
      return { type: "heading", level: level as 1 | 2 | 3, text: assertSafeText(node.text) };
    }
    case "paragraph":
      return { type: "paragraph", text: assertSafeText(node.text) };
    case "bold":
      return { type: "bold", text: assertSafeText(node.text) };
    case "italic":
      return { type: "italic", text: assertSafeText(node.text) };
    case "link":
      return { type: "link", text: assertSafeText(node.text), href: assertSafeHref(node.href) };
    case "bulletList":
    case "orderedList": {
      if (!Array.isArray(node.items)) {
        throw new https.HttpsError("invalid-argument", "List nodes require an items array.");
      }
      return { type: node.type, items: node.items.map((item) => assertSafeText(item)) };
    }
    default:
      throw new https.HttpsError("invalid-argument", `Disallowed content node type: ${String(node.type)}.`);
  }
}

function validateContent(raw: unknown): SiteContentSectionContent {
  if (typeof raw !== "object" || raw === null || !("nodes" in raw)) {
    throw new https.HttpsError("invalid-argument", "draftContent requires a nodes array.");
  }
  const content = raw as Record<string, unknown>;
  if (!Array.isArray(content.nodes)) {
    throw new https.HttpsError("invalid-argument", "draftContent.nodes must be an array.");
  }
  const nodes = content.nodes.map(validateNode);

  let images: SiteContentSectionContent["images"];
  if (content.images !== undefined) {
    if (typeof content.images !== "object" || content.images === null) {
      throw new https.HttpsError("invalid-argument", "images must be an object keyed by field name.");
    }
    images = {};
    for (const [key, value] of Object.entries(content.images as Record<string, unknown>)) {
      const ref = value as Record<string, unknown>;
      const storagePath = String(ref?.storagePath ?? "");
      const altText = String(ref?.altText ?? "");
      if (!storagePath.startsWith("siteContent/")) {
        throw new https.HttpsError("invalid-argument", `Image "${key}" must reference a siteContent/ storage path.`);
      }
      if (/\.svg$/i.test(storagePath)) {
        throw new https.HttpsError("invalid-argument", "SVG images are not permitted (Section 2.4).");
      }
      if (!altText) {
        throw new https.HttpsError("invalid-argument", `Image "${key}" requires alt text.`);
      }
      images[key] = { storagePath, altText };
    }
  }

  return { nodes, ...(images ? { images } : {}) };
}

function requireKnownSection(sectionId: unknown): string {
  const id = String(sectionId ?? "");
  if (!SITE_CONTENT_SECTION_IDS.includes(id as (typeof SITE_CONTENT_SECTION_IDS)[number])) {
    throw new https.HttpsError("invalid-argument", `Unknown sectionId. Must be one of: ${SITE_CONTENT_SECTION_IDS.join(", ")}.`);
  }
  return id;
}

/**
 * getPublicSiteContent — unauthenticated, used by every landing page
 * render path. Returns only publishedContent + version per section, never
 * draftContent, per Section 2.1's "no code path that can accidentally
 * read draftContent" requirement.
 */
export const getPublicSiteContent = https.onCall(async (request) => {
  checkAppCheck(request, "getPublicSiteContent");
  const ip = request.rawRequest?.ip ?? "unknown";
  await enforceRateLimit(`public:${ip}`, "getPublicSiteContent", 60);

  const snap = await db.collection("siteContent").get();
  const sections: Record<string, { content: SiteContentSectionContent; version: number } > = {};
  snap.forEach((doc) => {
    const data = doc.data() as SiteContentDoc;
    if (data.publishedContent) {
      sections[doc.id] = { content: data.publishedContent, version: data.version };
    }
  });
  return { success: true, sections };
});

/**
 * getSiteContentDraft — Super-Admin only. Returns the full document
 * (draft + published + version metadata) so the CMS editor can load
 * existing content instead of starting blank on every visit, and can
 * preview draftContent before publishing (Section 2.1).
 */
export const getSiteContentDraft = https.onCall(async (request) => {
  checkAppCheck(request, "getSiteContentDraft");
  await assertAdmin(request, ["super_admin"]);

  const data = request.data as { sectionId?: unknown } | undefined;
  const sectionId = requireKnownSection(data?.sectionId);

  const snap = await db.collection("siteContent").doc(sectionId).get();
  if (!snap.exists) {
    return { success: true, sectionId, doc: null };
  }
  return { success: true, sectionId, doc: snap.data() as SiteContentDoc };
});

/**
 * saveSiteContentDraft — Super-Admin only. Writes draftContent, never
 * touches publishedContent, never affects the live page (Section 2.1).
 */
export const saveSiteContentDraft = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "saveSiteContentDraft");
  const { uid } = await assertAdmin(request, ["super_admin"]);

  const data = request.data as { sectionId?: unknown; draftContent?: unknown } | undefined;
  const sectionId = requireKnownSection(data?.sectionId);
  const draftContent = validateContent(data?.draftContent);

  const ref = db.collection("siteContent").doc(sectionId);
  const snap = await ref.get();
  const now = FieldValue.serverTimestamp();

  const before = snap.exists ? (snap.data() as SiteContentDoc).draftContent : null;

  if (!snap.exists) {
    const doc: SiteContentDoc = {
      sectionId,
      draftContent,
      publishedContent: null,
      previousPublishedContent: null,
      status: "draft",
      version: 0,
      publishedAt: null,
      publishedBy: null,
      updatedAt: now,
      updatedBy: uid,
    };
    await ref.set(doc);
  } else {
    await ref.update({ draftContent, status: "draft", updatedAt: now, updatedBy: uid });
  }

  await writeAuditLog({
    requestId,
    functionName: "saveSiteContentDraft",
    actorUid: uid,
    actorRole: "admin",
    actorType: "admin",
    targetType: "siteContent",
    targetId: sectionId,
    eventType: "siteContent.save_draft",
    before: before as Record<string, unknown> | null,
    after: draftContent as unknown as Record<string, unknown>,
    appCheck,
  });

  return { success: true, sectionId };
});

/**
 * publishSiteContent — Super-Admin only. Copies draftContent into
 * publishedContent, increments version, retains the prior published
 * snapshot for legal-page rollback (Section 2.1). Concurrent-edit handling
 * (Section 13 item 17): the Firestore transaction makes the last publish
 * call the one that wins; every call — winning or not — writes its own
 * audit log entry, so both attempts are recorded.
 */
export const publishSiteContent = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "publishSiteContent");
  const { uid } = await assertAdmin(request, ["super_admin"]);

  const data = request.data as { sectionId?: unknown } | undefined;
  const sectionId = requireKnownSection(data?.sectionId);
  const ref = db.collection("siteContent").doc(sectionId);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new https.HttpsError("not-found", "No draft exists for this section yet.");
    }
    const current = snap.data() as SiteContentDoc;
    if (!current.draftContent) {
      throw new https.HttpsError("failed-precondition", "Nothing to publish.");
    }
    const now = FieldValue.serverTimestamp();
    const nextVersion = (current.version ?? 0) + 1;

    const isLegal = LEGAL_SECTION_IDS.has(sectionId);
    tx.update(ref, {
      publishedContent: current.draftContent,
      previousPublishedContent: isLegal ? current.publishedContent ?? null : current.previousPublishedContent ?? null,
      status: "published",
      version: nextVersion,
      publishedAt: now,
      publishedBy: uid,
      updatedAt: now,
      updatedBy: uid,
    });
    return { nextVersion };
  });

  await writeAuditLog({
    requestId,
    functionName: "publishSiteContent",
    actorUid: uid,
    actorRole: "admin",
    actorType: "admin",
    targetType: "siteContent",
    targetId: sectionId,
    eventType: "siteContent.publish",
    metadata: { version: result.nextVersion },
    appCheck,
  });

  return { success: true, sectionId, version: result.nextVersion };
});
