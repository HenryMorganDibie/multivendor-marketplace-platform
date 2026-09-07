import { onObjectFinalized } from "firebase-functions/v2/storage";
import sharp from "sharp";
import { admin, db, FieldValue } from "../admin";
import { logOperationalEvent } from "../utils/operationalLogging";

/**
 * CMS image processing, per LANDING_PAGE_CMS_VENDOR_PORTAL_MAPPING.md Section 2.4:
 * "Maximum file size and pixel dimensions are enforced server-side at
 * upload time, with automatic compression/resizing to a standard
 * web-appropriate size."
 *
 * Storage Rules (firestore/storage.rules, match /siteContent/{fileId})
 * already enforce Super-Admin-only write, the JPEG/PNG/WebP format
 * allowlist, and the 10MB size cap, but Rules just can't decode image bytes,
 * so pixel-dimension rejection and the actual resize/compression have to
 * happen here, after the bytes already exist in the bucket.
 *
 * Same onObjectFinalized trigger shape as ./scanUploadedFile.ts, for
 * consistency with this codebase's established pattern for post-upload
 * Storage processing, but deliberately a separate function rather than an
 * addition to that one: malware scanning and image processing are
 * unrelated concerns with different failure postures (fail-open to a
 * scanner outage vs. fail-safe on a corrupt image below), and folding them
 * together would make both harder to reason about.
 *
 * REPROCESSING LOOP: the resize/compress step ends by overwriting the same
 * object it was triggered by (bucket.file(name).save(...)), which itself
 * is a new object generation and therefore a new "finalize" event on the
 * exact same path; left unguarded, this function would re-invoke itself
 * forever. This is solved the standard way for GCS-triggered functions
 * that write back to their own trigger path: the overwrite carries a
 * custom object-metadata flag (`cmsImageProcessed: "true"`), and the very
 * first substantive check in the handler is "does the incoming event
 * already have that flag": if so, this is our own write coming back
 * around, and the function returns immediately without touching anything.
 * This is the one thing in this file that's easy to reintroduce a bug in
 * during a future edit: if the final `file.save()` call is ever changed,
 * make sure the metadata flag still goes out with it.
 */

const CMS_IMAGE_PREFIX = "siteContent/";

// Sanity ceiling, not a precise business requirement, just a guard rail
// against something like an accidentally-uploaded 20000x20000px file. A
// marketing site never legitimately needs a source image anywhere near
// this large.
const MAX_DIMENSION_PX = 4000;

// "Standard web-appropriate size" per Section 2.4. The long edge is capped
// here; the short edge scales proportionally. `fit: "inside"` combined
// with `withoutEnlargement` below means this is a no-op for images already
// within bounds, so it only ever shrinks, never upscales.
const TARGET_LONG_EDGE_PX = 2000;

const JPEG_QUALITY = 82;
const WEBP_QUALITY = 82;

const PROCESSED_FLAG_KEY = "cmsImageProcessed";

export const processSiteContentImage = onObjectFinalized(
  {
    // Must match scanUploadedFile.ts's bucket/region: onObjectFinalized
    // resolves the default bucket from FIREBASE_CONFIG at module-load
    // time when omitted, which only exists in the deployed runtime, not
    // during the CLI's local introspection pass, and Storage triggers
    // must run in the same region as the bucket itself (an Eventarc
    // requirement), which for this project's default bucket is us-east1.
    bucket: "platform-dev.firebasestorage.app",
    region: "us-east1",
    memory: "512MiB",
    timeoutSeconds: 120,
  },
  async (event) => {
    const { bucket: bucketName, name, contentType, metadata } = event.data;
    if (!name || !name.startsWith(CMS_IMAGE_PREFIX)) return;

    // Our own overwrite from the bottom of this function coming back
    // around as a new finalize event; see the REPROCESSING LOOP comment
    // at the top of this file.
    if (metadata?.[PROCESSED_FLAG_KEY] === "true") return;

    if (!contentType || !/^image\/(jpeg|jpg|png|webp)$/.test(contentType)) {
      // Storage Rules already restrict siteContent/ writes to these
      // content types; this is defense in depth only, not a path this
      // should normally reach. Nothing safe to do with an unexpected
      // type, so leave the object untouched.
      logOperationalEvent({
        functionName: "processSiteContentImage",
        event: "unexpected_content_type",
        severity: "WARNING",
        metadata: { bucket: bucketName, name, contentType: contentType ?? null },
      });
      return;
    }

    const bucket = admin.storage().bucket(bucketName);
    const file = bucket.file(name);

    let inputBuffer: Buffer;
    try {
      [inputBuffer] = await file.download();
    } catch (err) {
      logOperationalEvent({
        functionName: "processSiteContentImage",
        event: "download_failed",
        severity: "ERROR",
        metadata: { bucket: bucketName, name, errorMessage: err instanceof Error ? err.message : String(err) },
      });
      return;
    }

    let width: number | undefined;
    let height: number | undefined;
    let format: string | undefined;
    try {
      const probe = await sharp(inputBuffer).metadata();
      width = probe.width;
      height = probe.height;
      format = probe.format;
    } catch (err) {
      // Fail safe, matching the posture scanUploadedFile.ts uses for its
      // own failure cases: a file this function can't parse is not
      // something it should guess about. Log it and leave the object
      // exactly as uploaded rather than deleting a real admin's real
      // upload or crashing the trigger.
      logOperationalEvent({
        functionName: "processSiteContentImage",
        event: "image_parse_failed",
        severity: "WARNING",
        metadata: { bucket: bucketName, name, errorMessage: err instanceof Error ? err.message : String(err) },
      });
      return;
    }

    if (!width || !height || !format) {
      logOperationalEvent({
        functionName: "processSiteContentImage",
        event: "image_parse_failed",
        severity: "WARNING",
        metadata: { bucket: bucketName, name, reason: "missing_dimensions_or_format" },
      });
      return;
    }

    if (width > MAX_DIMENSION_PX || height > MAX_DIMENSION_PX) {
      await file.delete({ ignoreNotFound: true });
      await db.collection("cmsImageProcessingEvents").add({
        bucket: bucketName,
        name,
        contentType,
        width,
        height,
        status: "rejected_oversized_dimensions",
        createdAt: FieldValue.serverTimestamp(),
      });
      logOperationalEvent({
        functionName: "processSiteContentImage",
        event: "rejected_oversized_dimensions",
        severity: "WARNING",
        metadata: { bucket: bucketName, name, width, height, maxDimensionPx: MAX_DIMENSION_PX },
      });
      return;
    }

    let pipeline = sharp(inputBuffer).resize({
      width: TARGET_LONG_EDGE_PX,
      height: TARGET_LONG_EDGE_PX,
      fit: "inside",
      withoutEnlargement: true,
    });

    switch (format) {
      case "jpeg":
        pipeline = pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true });
        break;
      case "png":
        // PNG is inherently lossless; CMS images can be logos/graphics
        // with transparency, which is not safe to lossy-recompress. This
        // only raises zlib compression effort (near-lossless size win),
        // it does not reduce color/alpha fidelity.
        pipeline = pipeline.png({ compressionLevel: 9 });
        break;
      case "webp":
        pipeline = pipeline.webp({ quality: WEBP_QUALITY });
        break;
      default:
        // Not reachable given the contentType check above, but guard
        // anyway rather than silently re-encode into a format nothing
        // upstream expects.
        logOperationalEvent({
          functionName: "processSiteContentImage",
          event: "unsupported_format_for_reencode",
          severity: "WARNING",
          metadata: { bucket: bucketName, name, format },
        });
        return;
    }

    let outputBuffer: Buffer;
    try {
      outputBuffer = await pipeline.toBuffer();
    } catch (err) {
      logOperationalEvent({
        functionName: "processSiteContentImage",
        event: "image_process_failed",
        severity: "WARNING",
        metadata: { bucket: bucketName, name, errorMessage: err instanceof Error ? err.message : String(err) },
      });
      return;
    }

    try {
      await file.save(outputBuffer, {
        contentType,
        metadata: {
          contentType,
          metadata: { [PROCESSED_FLAG_KEY]: "true" },
        },
        resumable: false,
      });
    } catch (err) {
      logOperationalEvent({
        functionName: "processSiteContentImage",
        event: "save_failed",
        severity: "ERROR",
        metadata: { bucket: bucketName, name, errorMessage: err instanceof Error ? err.message : String(err) },
      });
    }
  }
);
