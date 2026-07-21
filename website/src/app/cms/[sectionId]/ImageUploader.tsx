"use client";

import { useState } from "react";
import { ref, uploadBytes } from "firebase/storage";
import { storage } from "@/lib/firebase";
import { SiteContentImageRef } from "@/lib/types";

export default function ImageUploader({
  images,
  onChange,
}: {
  images: Record<string, SiteContentImageRef>;
  onChange: (images: Record<string, SiteContentImageRef>) => void;
}) {
  const [key, setKey] = useState("");
  const [altText, setAltText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleUpload() {
    if (!file || !key.trim() || !altText.trim()) {
      setError("Image key, alt text, and a file are all required.");
      return;
    }
    if (/svg/i.test(file.type)) {
      setError("SVG images aren't allowed (XSS risk).");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const objectName = `siteContent/${crypto.randomUUID()}-${file.name}`;
      await uploadBytes(ref(storage, objectName), file);
      onChange({ ...images, [key.trim()]: { storagePath: objectName, altText: altText.trim() } });
      setKey("");
      setAltText("");
      setFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  function removeImage(imageKey: string) {
    const next = { ...images };
    delete next[imageKey];
    onChange(next);
  }

  return (
    <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
      <p className="text-sm font-semibold">Images</p>

      {Object.keys(images).length > 0 && (
        <ul className="mt-3 space-y-2">
          {Object.entries(images).map(([imageKey, img]) => (
            <li key={imageKey} className="flex items-center justify-between text-sm">
              <span>
                <span className="font-mono text-xs text-gray-500">{imageKey}</span> — {img.altText}
              </span>
              <button type="button" onClick={() => removeImage(imageKey)} className="text-xs text-red-500 hover:text-red-700">
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <input
          placeholder="Image key (e.g. hero)"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
        />
        <input
          placeholder="Alt text"
          value={altText}
          onChange={(e) => setAltText(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
        />
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-sm"
        />
      </div>
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      <button
        type="button"
        onClick={handleUpload}
        disabled={uploading}
        className="mt-3 rounded-full border border-gray-300 px-4 py-1 text-xs font-semibold hover:border-brand hover:text-brand disabled:opacity-50"
      >
        {uploading ? "Uploading…" : "Upload image"}
      </button>
    </div>
  );
}
