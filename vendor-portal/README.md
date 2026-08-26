# the platform Vendor Portal

Web portal for vendors to manage subscriptions, billing, and account information. (Storefront settings are explicitly out of scope for this package unless separately priced — see "What's not done here" below.)

Next.js app covering vendor login, subscription management, billing history, and invoices — per `LANDING_PAGE_CMS_VENDOR_PORTAL_MAPPING.md` Section 4 in `platform-backend/docs`. Login-only for MVP; vendor registration stays mobile-only.

Extracted from `platform-backend/web`'s `portal` route group (plus the public `invoice/[shareToken]` share-link view, which shares the same invoice types/components) into its own repo, per the client's direction to separate frontend apps from the Firebase backend before launch. It was already a self-contained Next.js app with its own `package.json`, no shared dependencies with Cloud Functions — the only real change in the extraction was flattening routes from `/portal/subscription` etc. to `/subscription`, since this app now owns its own root (`vendor.theplatform.com`) instead of sharing one with the marketing site.

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

`.env.local.example`'s default is already Option A (`NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-platform`) — no edits needed. Open `http://localhost:3000` — an unauthenticated visitor is redirected to `/login`. A fresh emulator has no vendor accounts; either register one through the mobile app pointed at the same emulator, or create one directly (Auth emulator UI at `http://127.0.0.1:4000/auth` plus the `completeRegistration` callable — see any `platform-backend/scripts/*.js` `setup()` function for the exact shape).

### Option B — a real Firebase project

Leave `NEXT_PUBLIC_USE_FIREBASE_EMULATOR` unset (or `false`) and fill in `.env.local` with the real Firebase Web App config instead:

```
firebase apps:sdkconfig web --project platform-dev
```

These are public client identifiers (not secrets), but real ones — not placeholders — are required for the app to connect to Firebase Auth/Functions/Storage this way. `npm run build` will fail with `auth/invalid-api-key` until `.env.local` is filled in (Option A sidesteps this entirely, since the emulator doesn't validate the dummy key).

## Routes

- `/` — redirects to `/subscription`.
- `/login` — vendor sign-in.
- `/subscription` — view/change plan, all ten subscription states.
- `/billing` — vendor-safe billing history projection.
- `/invoices` — list, create, download PDF, share.
- `/invoice/[shareToken]` — public, unauthenticated invoice view used by the Share action. The one route in this app that doesn't require login.

Account access (Section 4.1) is enforced server-side by `getVendorPortalAccess` — the client-side gating in `PortalChrome.tsx` only decides what to render, it isn't the real security boundary.

## What changed in the extraction

- Routes flattened: `/portal/subscription` → `/subscription`, `/portal/login` → `/login`, etc.
- `layout.tsx` was split into a Server Component (`layout.tsx`, owns `metadata`) and a Client Component (`PortalChrome.tsx`, owns the auth-gating logic) — the original combined file couldn't export `metadata` once it became a standalone app that needed its own `<title>`/`robots` metadata, since Next.js requires `metadata` exports to live in a Server Component.
- `invoices/page.tsx`'s share-link `SITE_URL` fallback changed from `www.theplatform.com` to `vendor.theplatform.com`, matching where this app actually deploys.

## What's not done here

- Deployment to `vendor.theplatform.com` (hosting, SSL, custom domain, environment separation) — this repo is app code only.
- Dashboard, storefront settings, and full vendor onboarding — explicitly out of scope for this package; the portal stays a focused subscriptions + invoices utility.
