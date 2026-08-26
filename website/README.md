# the platform Website

Public marketing website for the platform, including the landing page, feature pages, pricing, FAQ, legal pages, contact page, and CMS-managed content.

Next.js app covering the public landing page (14 pages) and the CMS editor — per `LANDING_PAGE_CMS_VENDOR_PORTAL_MAPPING.md` in `platform-backend/docs`.

Extracted from `platform-backend/web`'s `(marketing)` and `cms` route groups into its own repo, per the client's direction to separate frontend apps from the Firebase backend before launch. Nothing about the code changed in the extraction beyond fixing a couple of now-dead cross-app links (see "What changed" below) — it was already a self-contained Next.js app with its own `package.json`, no shared dependencies with Cloud Functions.

## Setup

```
npm install
cp .env.local.example .env.local
```

### Option A — run it against the local emulator (fastest, no real Firebase project needed)

This is how anyone can actually click through the app without waiting on real Firebase credentials. It's the same emulator `platform-backend`'s acceptance test scripts use — this repo depends on that one being checked out alongside it (as a sibling directory) to run the emulator, but not to build or deploy.

```bash
# Terminal 1 — from a checkout of platform-backend
firebase emulators:start --only auth,firestore,functions,storage --project demo-platform

# Terminal 2 — from this repo
npm run dev
```

`.env.local.example`'s default is already Option A (`NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-platform`) — no edits needed. Open `http://localhost:3000`. Pages render with fallback content (nothing's been published through the CMS in a fresh emulator). `/cms` needs a Super-Admin account — create one via the emulator's Auth UI at `http://127.0.0.1:4000/auth` plus setting the right custom claims (see `platform-backend/scripts/*.js` for the exact shape `assertAdmin` expects).

### Option B — a real Firebase project

Leave `NEXT_PUBLIC_USE_FIREBASE_EMULATOR` unset (or `false`) and fill in `.env.local` with the real Firebase Web App config instead:

```
firebase apps:sdkconfig web --project platform-dev
```

These are public client identifiers (not secrets), but real ones — not placeholders — are required for the app to connect to Firebase Auth/Functions/Storage this way. `npm run build` will fail with `auth/invalid-api-key` until `.env.local` is filled in (Option A sidesteps this entirely, since the emulator doesn't validate the dummy key).

## Routes

- `/`, `/features`, `/pricing`, `/vendors`, `/customers`, `/faq`, `/contact`, `/about`, and six legal pages. Content renders from the `siteContent` Firestore collection via `getPublicSiteContent`, falling back to code-owned placeholder copy until the client's real copy is published through the CMS.
- `/cms` — Super-Admin-only content editor (draft/publish workflow).

The Vendor Portal (`/portal` in the old combined app) and the public invoice share view (`/invoice/[shareToken]`) live in the separate `platform-vendor-portal` repo now, not here.

## What changed in the extraction

- `robots.ts` no longer disallows `/portal` (that route doesn't exist in this app anymore) — only `/cms` is disallowed.
- The root `layout.tsx`'s comment explaining the chrome split was updated to reflect that the Vendor Portal is a separate app now, not a sibling route group.
- Nothing else — `SiteHeader`/`SiteFooter`'s "Vendor Login" links were already absolute URLs to `https://vendor.theplatform.com`, not relative `<Link>`s, so no routing broke.

## What's not done here

- Real marketing/legal copy — the client supplies this; pages currently render placeholder fallback content until published through the CMS.
- Deployment to `www.theplatform.com` (hosting, SSL, custom domain, environment separation) — this repo is app code only.
- Legal-page one-click rollback UI — the backend retains the immediately prior published version (`previousPublishedContent`), but the CMS editor doesn't yet expose a "restore previous version" button.
- Formal accessibility audit and full analytics/monitoring setup — acceptance-criteria-level only, per scope.
