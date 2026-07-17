"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { callable } from "@/lib/firebase";
import { SiteContentSectionId, SiteContentSectionContent, SITE_CONTENT_SECTION_IDS } from "@/lib/types";
import RichText from "@/components/RichText";
import NodeEditor from "./NodeEditor";
import ImageUploader from "./ImageUploader";

interface SiteContentDocShape {
  draftContent: SiteContentSectionContent;
  publishedContent: SiteContentSectionContent | null;
  previousPublishedContent?: SiteContentSectionContent | null;
  status: "draft" | "published";
  version: number;
}

interface GetDraftResponse {
  success: true;
  sectionId: string;
  doc: SiteContentDocShape | null;
}

const EMPTY_CONTENT: SiteContentSectionContent = { nodes: [] };

export default function CmsSectionEditorPage() {
  const params = useParams<{ sectionId: string }>();
  const sectionId = params.sectionId as SiteContentSectionId;

  const [content, setContent] = useState<SiteContentSectionContent>(EMPTY_CONTENT);
  const [doc, setDoc] = useState<SiteContentDocShape | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [preview, setPreview] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!SITE_CONTENT_SECTION_IDS.includes(sectionId)) return;
    setLoading(true);
    const getDraft = callable<{ sectionId: string }, GetDraftResponse>("getSiteContentDraft");
    getDraft({ sectionId })
      .then((res) => {
        const loadedDoc = res.data.doc;
        setDoc(loadedDoc);
        setContent(loadedDoc?.draftContent ?? EMPTY_CONTENT);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load content."))
      .finally(() => setLoading(false));
  }, [sectionId]);

  async function handleSaveDraft() {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const save = callable<{ sectionId: string; draftContent: SiteContentSectionContent }, { success: true }>("saveSiteContentDraft");
      await save({ sectionId, draftContent: content });
      setMessage("Draft saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save draft.");
    } finally {
      setSaving(false);
    }
  }

  async function handlePublish() {
    setPublishing(true);
    setMessage(null);
    setError(null);
    try {
      await handleSaveDraft();
      const publish = callable<{ sectionId: string }, { success: true; version: number }>("publishSiteContent");
      const res = await publish({ sectionId });
      setMessage(`Published — now live as version ${res.data.version}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't publish.");
    } finally {
      setPublishing(false);
    }
  }

  if (!SITE_CONTENT_SECTION_IDS.includes(sectionId)) {
    return <p className="text-sm text-red-600 dark:text-red-400">Unknown section.</p>;
  }

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{sectionId}</h1>
        <div className="flex gap-2 text-xs text-gray-500">
          <span>{doc ? `Version ${doc.version}` : "Not yet published"}</span>
        </div>
      </div>

      {message && <p className="mt-3 rounded-lg bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-300">{message}</p>}
      {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={() => setPreview((v) => !v)}
          className="rounded-full border border-gray-300 px-4 py-2 text-sm font-semibold hover:border-brand hover:text-brand"
        >
          {preview ? "Back to editing" : "Preview draft"}
        </button>
      </div>

      {preview ? (
        <div className="mt-6 rounded-2xl border border-gray-200 p-6 dark:border-gray-800">
          <RichText content={content} />
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          <NodeEditor nodes={content.nodes} onChange={(nodes) => setContent({ ...content, nodes })} />
          <ImageUploader images={content.images ?? {}} onChange={(images) => setContent({ ...content, images })} />
        </div>
      )}

      <div className="mt-8 flex gap-3">
        <button
          type="button"
          onClick={handleSaveDraft}
          disabled={saving || publishing}
          className="rounded-full border border-gray-300 px-6 py-2 text-sm font-semibold hover:border-brand hover:text-brand disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save Draft"}
        </button>
        <button
          type="button"
          onClick={handlePublish}
          disabled={saving || publishing}
          className="rounded-full bg-brand px-6 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
        >
          {publishing ? "Publishing…" : "Publish"}
        </button>
      </div>
    </div>
  );
}
