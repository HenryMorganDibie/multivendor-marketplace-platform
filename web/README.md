# the platform Web

Next.js app covering the public landing page (14 pages), the CMS editor, and the Vendor Portal — per `docs/LANDING_PAGE_CMS_VENDOR_PORTAL_MAPPING.md`.

## Setup

```
cd web
npm install
cp .env.local.example .env.local
```

### Option A — run it against the local emulator (fastest, no real Firebase project needed)

This is how anyone can actually click through the app without waiting on real Firebase credentials. It's the same emulator the backend's acceptance test scripts (`scripts/*.js`) already use.

```bash
# Terminal 1, from the repo root — starts the backend the web app will call
firebase emulators:start --only auth,firestore,functions,storage --project demo-the platform

# Terminal 2
cd web
npm run dev
```

`.env.local.example`'s default is already Option A (`NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-the platform`) — no edits needed. Open `http://localhost:3000`. The public landing pages render with fallback content (nothing's been published through the CMS in a fresh emulator), and `/portal`/`/cms` need an account — either register a vendor through the mobile app pointed at the same emulator, or create one directly via the emulator's Auth UI at `http://127.0.0.1:4000/auth` plus the `completeRegistration` callable (see any `scripts/*.js` `setup()` function for the exact shape). Data doesn't persist across emulator restarts unless you pass `--import`/`--export-on-exit`.

### Option B — a real Firebase project

Leave `NEXT_PUBLIC_USE_FIREBASE_EMULATOR` unset (or `false`) and fill in `.env.local` with the real Firebase Web App config instead:

```
firebase apps:sdkconfig web --project the platform-dev
```

These are public client identifiers (not secrets), but real ones — not placeholders — are required for the app to connect to Firebase Auth/Functions/Storage this way. `npm run build` will fail with `auth/invalid-api-key` until `.env.local` is filled in (Option A sidesteps this entirely, since the emulator doesn't validate the dummy key).

## Routes

- `/`, `/features`, `/pricing`, `/vendors`, `/customers`, `/faq`, `/contact`, `/about`, and six legal pages — the public landing page. Content renders from the `siteContent` Firestore collection via `getPublicSiteContent`, falling back to code-owned placeholder copy until the client's real copy is published through the CMS.
- `/cms` — Super-Admin-only content editor (draft/publish workflow, Section 2).
- `/portal` — Vendor Portal (subscriptions, billing history, invoices, Section 4). Login-only for MVP; registration stays mobile-only.
- `/invoice/[shareToken]` — public invoice view, used by the portal's Share action.

## What's not done here

- Real marketing/legal copy — the client supplies this (Section 5); pages currently render placeholder fallback content until published through the CMS.
- Separate `www.the platform.com` / `vendor.the platform.com` domain split (Section 6.5) — currently one Next.js app with `/portal` and `/cms` path prefixes. Splitting onto subdomains is a deployment-config change (rewrites or separate deploy targets), not a code change.
- Legal-page one-click rollback UI — the backend retains the immediately prior published version (`previousPublishedContent`) per Section 2.1, but the CMS editor doesn't yet expose a "restore previous version" button.
- Formal accessibility audit and full analytics/monitoring setup (Section 6.2/6.5) — acceptance-criteria-level only, per scope.
