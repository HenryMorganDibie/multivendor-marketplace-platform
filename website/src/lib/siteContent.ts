import "server-only";
import { GetPublicSiteContentResponse, SiteContentSectionContent, SiteContentSectionId } from "./types";

/**
 * Server-side fetch of published CMS content via getPublicSiteContent.
 * Runs at request/build time in a Server Component — never in the
 * browser — so no client Firestore access is needed for the landing
 * pages at all. Falls back to null per-section when the CMS hasn't
 * published that section yet (fresh install, or the client's copy not
 * loaded), so pages still render with the code-owned fallback content
 * baked into each page component.
 */
export type PublishedSections = Record<string, { content: SiteContentSectionContent; version: number }>;

export async function getPublishedSiteContent(): Promise<PublishedSections> {
  const region = process.env.NEXT_PUBLIC_FIREBASE_FUNCTIONS_REGION ?? "us-central1";
  const useEmulator = process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === "true";
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || (useEmulator ? "demo-platform" : undefined);
  if (!projectId) return {};

  // Emulator mode calls the local Functions emulator directly (the
  // production https://{region}-{projectId}.cloudfunctions.net URL format
  // doesn't exist locally) — same host/port the acceptance test scripts
  // and firebase.ts's client-side emulator connection use.
  const url = useEmulator
    ? `http://127.0.0.1:5001/${projectId}/${region}/getPublicSiteContent`
    : `https://${region}-${projectId}.cloudfunctions.net/getPublicSiteContent`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: {} }),
      next: { revalidate: 60 },
    });
    if (!res.ok) return {};
    const json = (await res.json()) as { result?: GetPublicSiteContentResponse };
    return json.result?.sections ?? {};
  } catch {
    return {};
  }
}

export function sectionOrFallback(
  sections: PublishedSections,
  sectionId: SiteContentSectionId,
  fallback: SiteContentSectionContent
): { content: SiteContentSectionContent; version: number | null } {
  const entry = sections[sectionId];
  return entry ? { content: entry.content, version: entry.version } : { content: fallback, version: null };
}
