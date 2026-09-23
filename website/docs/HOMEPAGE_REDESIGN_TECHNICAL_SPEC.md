# Platform Homepage — Design Audit & Redesign Specification

**DESIGN DIRECTION ONLY. NO CODE HAS BEEN WRITTEN OR MODIFIED.**

Prepared: 2026-08-27
Scope: `this repo (website/)` homepage only (`src/app/(marketing)/page.tsx`)
Reference used for quality bar only: runway.com/pricing (not copied — layout, palette, content all diverge)

A note on method: this audit is grounded entirely in direct inspection of the actual repository; every file path, class name, and data structure cited below was read from the real code, not assumed. Where an asset or data point doesn't exist, that's stated plainly rather than glossed over. (One administrative note: I checked whether Composio — a connected tool-integration platform for things like Slack/Gmail/CRM automation — had anything relevant to offer here; it doesn't have a visual-design-reference or inspiration capability, so it contributes nothing to this specific task. The audit below is built from direct code inspection plus applied design judgment instead.)

---

## PART 0 — WHAT THE CODEBASE ACTUALLY CONTAINS (ground truth, read first)

Three facts drive most of the recommendations below, so stating them up front avoids re-deriving them section by section:

1. **`this repo (website/)/public/` is empty.** Zero images, zero icons-as-files, zero photography exist anywhere in this repository. `lucide-react` (already a dependency, v0.475.0) is the only visual asset library in use — it supplies line icons, nothing photographic.

2. **No category imagery exists anywhere in the product — mobile or web.** The canonical category list lives at `multivendor-marketplace-mobile/expo/constants/categories.ts` as `DAY_ONE_CATEGORIES`, a plain array of 12 strings. There's also a `CategoryDisplay` interface with an optional `image?: string` field — but grepping the entire mobile app confirms it is never populated by any real data. So "reuse the app's category images" is not an option; they don't exist and must be sourced from scratch (stock photography, commissioned shoot, or vendor-submitted photos pulled from real catalog items later). This is the single biggest asset dependency in this whole plan and is flagged honestly rather than assumed away.

3. **A real typographic system already exists and is good — it's just inconsistently applied.** `multivendor-marketplace-mobile/expo/constants/theme.ts` defines a deliberate `Typography` scale (`displayHero` 34/800/-0.8, `displayTitle` 30/800/-0.6, `pageTitle` 24/700/-0.4, `sectionTitle` 18/700/-0.2, `cardTitle` 16/600/-0.1, `body` 15/400, `sectionLabel` 12/700/+0.6 uppercase). The website's `RichText.tsx` component already ports this faithfully for CMS-driven headings (`h1`: `text-4xl md:text-5xl font-extrabold tracking-[-0.02em]`; `h2`: `text-2xl md:text-3xl font-bold tracking-[-0.015em]`). The actual bug: every hardcoded section heading in `page.tsx` (`Why Platform`, `How it works`, `Vendor Categories`, `Ready to start?`) is a raw `<h2 className="text-2xl font-bold tracking-[-0.015em] text-ink">` — same weight as RichText's h2, but **missing the `md:text-3xl` responsive step**, and never routed through the shared component at all. So this isn't "invent a new type system" — it's "stop hand-rolling headings that drift from the system that already exists three lines away."

These three facts reframe the whole engagement: the token system (color, radius, shadow, type scale) is already correct and shared correctly with the mobile app and vendor portal (`tailwind.config.ts` is confirmed byte-identical across `this repo (website/)` and `this repo (vendor-portal/)` on purpose, per its own header comment). **The problem is entirely in composition and asset absence, not in the design tokens.** Nothing in this plan proposes replacing the token system — only extending it (new scale steps, new surface treatments) and finally putting it to use.

---

## PART 1 — SECTION-BY-SECTION AUDIT OF THE CURRENT HOMEPAGE

Current file: `this repo (website/)/src/app/(marketing)/page.tsx` (206 lines, 7 sections + conditional screenshot block).

### 1.1 Navigation — `components/SiteHeader.tsx`

**What's there**: Sticky header, text wordmark "Platform" in `text-xl font-extrabold tracking-[-0.02em] text-brand`, 7 nav links, "Vendor Login" text link, "Become a Vendor" filled button, fully accessible mobile drawer (focus trap, escape-to-close, body-scroll lock, 48px tap targets — genuinely well-built, confirmed by reading the whole component).

**Why it reads as unfinished**:
- The wordmark is text only. There is no mark, glyph, or monogram — nothing a user could recognize at a glance separate from reading the word. Every credible consumer tech brand (Runway included) pairs a wordmark with a distinct mark.
- 7 nav links (`Features, Pricing, Vendors, Customers, FAQ, About, Contact`) is one link too many for a header to feel curated — it reads as "every page we have," not "the paths we want you to take." `FAQ` and `About` are the ones most sites tuck into the footer only (already present there) and drop from primary nav.
- The header treatment doesn't change value between hero and scrolled states — Runway-tier sites often let the header go from transparent-on-hero to solid-on-scroll, which is one of the compositional cues that makes a page feel directed rather than static chrome.

**Verdict**: mechanism is correct (accessibility, responsiveness) — keep it. Visual weight and information architecture need work.

**Specific fix**:
- Design (or commission) a simple geometric mark — even a monogram "L" in a rounded-square using the brand color, sized ~28px, sitting left of the wordmark. This is a real asset dependency (see Part 13).
- Trim primary nav to 5: `Features, Pricing, Vendors, Customers, Contact`. FAQ/About remain in the footer (already there) and can gain a "More" overflow if traffic data later says otherwise.
- Header background: `bg-white/90 backdrop-blur` (current) is fine and stays — it already does the "sticky, translucent" treatment correctly. No change needed there.

---

### 1.2 Hero — `page.tsx:114-135`

**What's there**:
```
<section className="bg-white">
  <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
    <div className="max-w-2xl">
      <RichText content={content} />   {/* "Buy and sell directly." + one paragraph */}
      <div className="mt-6 flex flex-wrap gap-3">
        [Become a Vendor] [Shop on Platform]
      </div>
    </div>
  </div>
</section>
```

**Why it reads as a prototype**:
- It's a text block in a box. `max-w-2xl` constrains the copy to the left ~40% of a `max-w-6xl` container on desktop, leaving the right ~60% of the hero **entirely empty white space** — not intentional negative space, just unused space, because nothing was ever designed to occupy it.
- "Buy and sell directly" is true of literally any peer-to-peer or marketplace product on earth. It doesn't tell a visitor Platform is mobile-first, chat-centric, vendor-verified, or built for direct local trade — the actual differentiators sit one paragraph down, in body copy, where fewer people read.
- Two CTAs of identical visual weight (`bg-brand` filled vs. bordered) is *correct as a pattern* (primary/secondary is right), but with no visual anchor above them, neither reads as "the" action — they're just two buttons under two sentences.
- This is the highest-traffic real estate on the entire site and it currently contains zero pixels of the actual product.

**Redesign direction**:
- Two-column asymmetric layout at `lg:` and up: text column (~45% width) left, a **device-frame product visual** (~50% width) right, vertically centered against the text block, allowed to bleed slightly past the container's right edge for a less boxed-in feel.
- Stack vertically on mobile/tablet: text first, device frame below, frame width capped at ~280px so the phone reads as a phone, not a poster.
- Headline direction (content, not final copy — the Founder still supplies/approves via CMS): lead with the *mechanism* that's actually differentiated — direct vendor chat before an order is real, live, working functionality today. Something in the register of "Talk to the vendor before you buy" or "Local vendors. Direct chat. Real orders." — specific enough that a competitor's homepage couldn't use the same sentence unchanged. (Final wording is the Founder's call through the CMS; this is a direction, not a copy deck.)
- The device frame shows one real, specific screen — the customer-facing chat-before-order thread is the strongest single choice, because it's the one interaction no generic e-commerce template can claim.
- CTA treatment: keep the two-button pattern, but give the primary (`Shop on Platform`, reordered ahead of `Become a Vendor` since customer acquisition is the wider funnel) slightly larger padding (`px-7 py-3.5` vs. current `px-6 py-3`) so it reads unambiguously as the lead action, with vendor recruitment as the secondary path.

---

### 1.3 "Why Platform" — `page.tsx:137-153`

**What's there**: `<h2>` + 4-column grid (`sm:grid-cols-2 lg:grid-cols-4`) of identical cards — `rounded-card border border-hairline p-5 shadow-soft` — each a bold title + one line of body text. No icon, no image, no visual differentiation between the four.

**Why it reads as template**: this exact pattern (icon-less bordered card × 4, one line each) is the single most recognizable "generic SaaS landing page" trope in existence — it's the default output of literally every page builder and AI site generator. Four cards of identical size, weight, and treatment also flattens hierarchy: "Verified Vendors" and "Built for Local Businesses" (a much bigger structural claim) get equal visual billing.

**Redesign direction**:
- Drop from 4 columns to 2 (desktop), 1 (mobile) — larger cards, more room to breathe, room for a supporting visual per card.
- Add a `lucide-react` icon per card, sized 28-32px, in a soft brand-tinted circle (`bg-brand-light`, matching the existing "Why Platform" number-badge pattern already used one section down in `StepFlow` — so this isn't a new visual idiom, it's extending one that's already in the codebase):
  - Verified Vendors → `ShieldCheck`
  - Chat Before Ordering → `MessageCircle`
  - Marketplace Orders → `PackageCheck`
  - Built for Local Businesses → `Store`
- Heading change: "Why Platform" → "Why customers choose Platform" (or similar customer-oriented framing) — the current heading is a section label, not a hook.

---

### 1.4 "How It Works" — `page.tsx:155-164`, `StepFlow` component (lines 68-85)

**What's there**: Two `StepFlow` instances (Customers: 4 steps, Vendors: 5 steps), each step a small bordered card with a numbered circle badge, a bold label, one line of body copy. `bg-surface-canvas` full-bleed section background (the one section that actually breaks from pure white — correctly done).

**Why it reads as a flowchart, not a story**: 9 nearly-identical numbered boxes across two rows is information-dense and visually flat at the same time. Nothing in the composition demonstrates *what actually happens* at each step — "Chat" is illustrated by the word "Chat," not by anything resembling a chat.

**Redesign direction**: This is the section most worth spending real screenshot budget on, because it's the natural home for demonstrating the product rather than describing it.
- Keep the two-flow structure (Customers / Vendors) — it's correct and matches the two real user types.
- Replace the numbered-box treatment with a horizontal step rail: each step still numbered (the number badge is a fine, already-established idiom — keep it), but each step now anchors a **small real screenshot** relevant to that step (browse grid → chat thread → order confirmation → order-status screen for the customer flow; register → verification-document upload → storefront/catalog screen → order-received screen → dashboard/analytics screen for the vendor flow).
- Connect steps with a thin horizontal line (`border-t border-dashed border-hairline-strong`) threading through the number badges, so the eye reads it as one continuous journey rather than four separate boxes.
- Mobile: steps stack vertically, connecting line becomes vertical, screenshots shrink to a smaller fixed width (~120px) so the whole flow still fits without excessive scroll.
- If real screenshots aren't ready for launch, this section can ship with the current text-only treatment initially and receive screenshots in a fast-follow — do not block the rest of the redesign on this one section's assets.

---

### 1.5 Vendor Categories — `page.tsx:166-179`

**What's there**:
```
<div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
  {VENDOR_CATEGORIES.map((category) => (
    <div className="rounded-button border border-hairline bg-surface px-4 py-3 text-center text-sm font-semibold text-ink">
      {category}
    </div>
  ))}
</div>
```
12 real categories (verbatim from `DAY_ONE_CATEGORIES`, see Part 0 — not renaming any of them): Food & Catering, Fashion, Beauty Tools, Home & Living, Electronics Repair, Baby & Kids, Bags & Accessories, Phone Accessories, Art & Handmade, Books & Stationery, Digital Products, Safe Verified Services.

**This is the section the client specifically flagged, and it's the correct thing to flag.** A flat grid of grey, centered-text, equal-weight pills is visually indistinguishable from a filter panel or a settings screen. There is no signal here that these are *things to discover* — no color variation, no imagery, no size hierarchy, nothing that differentiates "Fashion" from "Digital Products" other than the label. The heading "Vendor Categories" is also inward-facing terminology (it's how the *system* models the data) rather than customer-facing framing (a shopper thinks "what can I find here," not "what are the vendor categories").

**Three redesign options, as requested:**

**Option A — Image-led grid cards.**
12 cards (or a curated subset), each a fixed 4:3 or 1:1 image occupying ~70% of card height, category label + optional vendor-count overlaid at the bottom on a dark gradient scrim. Grid: `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4`, same breakpoints as today, larger gap (`gap-4` to `gap-5`). Straightforward to build, works well as a static grid, but 12 image cards is a lot of imagery to source/commission at once.

**Option B — Horizontal scroll rail (RECOMMENDED).**
A single horizontally-scrollable row, image-led cards ~180-200px wide × 240px tall (image top ~65% of height, label + optional count below on white/surface background rather than an overlay — cleaner and easier to keep legible against varied photography). Desktop shows 5-6 cards at once with a subtle edge fade indicating more content, no forced pagination arrows needed if native scroll-snap (`scroll-snap-type: x mandatory`, `snap-x` in Tailwind) is used — the row simply glides. Mobile gets the same component for free: horizontal touch-scroll is the single most natural mobile gesture available, and it's the one interaction this homepage currently has zero instances of.
- *Why recommended*: it matches how people already browse category rails on mobile marketplaces (this reads instantly as "a place to browse," which is exactly the reframe needed), it scales gracefully whether there are 12 categories or 30 later, and it doesn't require choosing which categories to cut for a fixed grid.
- Card content: category image, category name (`cardTitle` scale: 16px/600), no fabricated vendor counts unless real per-category vendor counts are available from the backend (they are queryable — `vendors` collection filtered by category — but this is a data-plumbing decision to confirm with the Founder before promising it, not something to invent).

**Option C — Asymmetric featured grid.**
One large "featured" category tile (2× width and height) paired with a standard grid of the rest. Visually striking, but arbitrarily privileging one category over the other eleven needs an actual editorial reason (seasonal push, most-active category) — without one, it looks arbitrary rather than curated, so this is the weakest of the three for a first pass.

**Recommendation: Option B.** Heading change: "Vendor Categories" → "What are you looking for?" or "Browse by category" — customer-oriented framing, matching the section's actual audience (a shopper, not an internal taxonomy).

**Hover/interaction**: subtle scale (1.03) + shadow lift on the card, image slightly darkens (10% overlay) to keep the label legible — desktop only; mobile has no hover state, tap navigates directly.

**Additional categories behavior**: rail simply continues scrolling; no "view all" needed unless the category list grows meaningfully beyond ~20, at which point a `/categories` or filtered `/vendors?category=` destination becomes worth a dedicated page — out of scope for this homepage pass.

---

### 1.6 App Screenshots section — `page.tsx:181-193`

**What's there**: Conditionally rendered only when `APP_SCREENSHOTS_AVAILABLE` (in `lib/appScreenshots.ts`) is `true` — it's currently `false`, so **this entire section does not render at all today**. The file's own comment is unusually candid about why: *"The sections previously rendered grids of dashed empty boxes reading 'Coming soon,' which made a finished page look like an unfinished wireframe... An absent section reads as a deliberate choice; six empty rectangles read as work someone forgot."* That was the correct call at the time it was made.

**Recommendation**: this dedicated bottom-of-page screenshot section becomes unnecessary under this redesign anyway, because real product screenshots are now woven into the Hero and the How It Works rail instead of being isolated in their own section. Once those two placements have real assets, this section and its flag can be retired rather than turned on.

---

### 1.7 Final CTA — `page.tsx:195-202`

**What's there**: Centered `<h2>Ready to start?</h2>`, two store badges, generous padding, otherwise empty.

**Why it's weak**: "Ready to start?" is the single most generic closing line in web copy — it appears on an enormous fraction of every SaaS site ever built precisely because it requires no thought. It also isn't clear *what* starting means here (download the app? browse? become a vendor?) — the two store badges answer "download," but nothing frames why.

**Redesign direction**:
- Full-bleed section, dark surface (a genuine charcoal, not the current white) — this is the one place on the page that should feel like a deliberate closing statement rather than a continuation of the same white canvas used everywhere else.
- Two-column composition on desktop: headline + supporting line + both store badges (sized up from their current footer-scale treatment) on the left; a second device-frame product shot on the right, distinct from the hero's shot (e.g., hero shows chat, closing shows an order-tracking or vendor-storefront screen) so the page opens and closes on two different, real moments in the product rather than repeating itself.
- Headline direction: something that names *both* audiences without splitting into two competing CTAs — e.g. "Download Platform" as the primary action with a secondary text link for vendor sign-up, rather than two more buttons duplicating the hero's pair.
- Mobile: stacks — headline, supporting copy, store badges, device frame below.

---

## PART 2 — PROPOSED HOMEPAGE STRUCTURE

| # | Section | Status |
|---|---|---|
| 1 | Navigation | Refine (mark + trimmed links), mechanism unchanged |
| 2 | Hero | Redesign — asymmetric layout + device frame |
| 3 | Why Platform | Redesign — 2-col, icon-supported |
| 4 | How It Works | Redesign — screenshot-anchored step rail |
| 5 | Browse by Category | Full redesign — horizontal image rail (Option B) |
| 6 | Final CTA | Redesign — dark full-bleed, two-sided close |
| 7 | Footer | Unchanged |

**No new sections are being added** (no fabricated "Trust & Verification" stat bar, no invented testimonials/case-studies section) — see Part 2a on why.

### 2a. On not inventing new sections

An earlier internal pass of this audit considered adding standalone "Trust & Verification" and "Vendor Growth Story" sections. On reflection against the brief's own constraint (**do not fabricate social proof, do not invent structure not grounded in real product truth**), both are dropped as *separate sections*:

- A dedicated trust/social-proof section with no real numbers to put in it just becomes another card grid with adjectives ("Secure," "Trusted," "Verified") and no data — exactly the generic pattern this whole audit is trying to eliminate. Verification is already communicated honestly today via the "Verified Vendors" card in Why Platform and the `/vendors` page's fuller explanation — that's the right amount of it for a homepage with no metrics to cite yet.
- "Vendor growth story" content (subscription tiers, dashboard/analytics) already has a dedicated, better-suited home: the `/vendors` and `/pricing` pages. Duplicating it on the homepage would dilute both the homepage's focus and those pages' reason to exist. The homepage's existing `Become a Vendor` CTA correctly routes there already.

This keeps the redesign honest to the brief (specifically the instruction not to fabricate social proof) and avoids scope creep into pages that weren't asked for.

---

## PART 3 — PRODUCT UI PLACEMENT (SUMMARY)

| Location | Screen shown | Frame style |
|---|---|---|
| Hero (right column, desktop) / below text (mobile) | Customer chat-before-order thread | Single iPhone device frame, slight shadow lift, allowed to bleed past container edge on desktop |
| How It Works — Customer rail | Browse grid → Chat → Order confirmation → Order tracking (4 small screens) | Small flat frames (no full device chrome — just a rounded-rect crop with a thin border), anchored above each numbered step |
| How It Works — Vendor rail | Register → Verification upload → Storefront/catalog → Orders received → Dashboard (5 small screens) | Same small-frame treatment as above |
| Final CTA (right column, desktop) | Order-tracking or vendor-storefront screen (distinct from hero) | Single device frame, mirrored composition of the hero |

No screenshot appears more than once. Device-frame chrome (the full phone outline) is reserved for the two "hero moment" placements (opening and closing); the step-rail screenshots use a lighter, flatter crop so nine repeated full phone outlines don't visually compete with each other mid-page.

---

## PART 4 — PRODUCT STORYTELLING (DISCOVER → EXPLORE → CHAT → ORDER → MANAGE)

This journey is already the natural shape of the existing "How It Works" section (Browse → Chat → Order → Receive for customers; the vendor flow is its mirror) — it does not need a *separate* section, it needs the redesign specified in Part 1.4 to actually show it rather than describe it. Introducing a second, parallel "journey" section elsewhere on the page would be redundant with How It Works and is not recommended.

---

## PART 5 — TYPOGRAPHY SYSTEM (extends the existing scale, does not replace it)

Built directly from `multivendor-marketplace-mobile/expo/constants/theme.ts`'s `Typography` object (Part 0.3) plus two new steps for marketing-scale display type that the native app never needed:

| Token | Size (desktop) | Size (mobile) | Weight | Tracking | Source |
|---|---|---|---|---|---|
| `display-2xl` (NEW — hero only) | 56px | 36px | 800 | -0.02em | New, above the app's own `displayHero` since a marketing hero needs more scale than an in-app screen title |
| `display-xl` (= RichText h1, unchanged) | 48px | 36px | 800 | -0.02em | Already `text-4xl md:text-5xl font-extrabold` in `RichText.tsx` |
| `heading-lg` (= RichText h2, unchanged) | 30px | 24px | 700 | -0.015em | Already `text-2xl md:text-3xl font-bold` in `RichText.tsx` — **the fix is routing every hardcoded page.tsx `<h2>` through this exact scale, not inventing a new one** |
| `heading-md` (= RichText h3, unchanged) | 20px | 20px | 700 | -0.01em | Already in `RichText.tsx` |
| `card-title` | 16px | 16px | 600 | -0.01em | = mobile's `cardTitle` token exactly |
| `body` | 16px | 15px | 400 | normal | Slightly larger than mobile's 15px `body` — screen reading distance differs, current site body copy is already `text-base` (16px) in `RichText.tsx`'s paragraph node, correctly |
| `label` | 12px | 12px | 700 | +0.06em, uppercase | = mobile's `sectionLabel` exactly — use for category counts, eyebrow text above section headings if added |

**The only genuinely new tokens are `display-2xl`** (hero headline only) **and formally naming `heading-lg` as the mandatory class for every section `<h2>`** so `page.tsx` stops drifting from `RichText.tsx`. Line-height stays generous on body (`leading-relaxed` = 1.625, already in use) — no change needed there, it's already correct.

---

## PART 6 — CARD SYSTEM

| Variant | Radius | Border | Shadow | Use |
|---|---|---|---|---|
| **Feature card** (Why Platform) | `rounded-card` (18px, unchanged) | none | `shadow-soft` (unchanged) | Icon + heading + body, 2-col desktop |
| **Category card** (NEW) | `rounded-card` (18px) | none | `shadow-soft`, `shadow-soft-md` on hover | Image top (4:5 ratio), label below on white ground |
| **Step card** (How It Works) | `rounded-card` (18px, unchanged) | `border-hairline` (unchanged) | `shadow-soft` (unchanged) | Small screenshot + number badge + label, kept mostly as-is, just anchored to a screenshot now |

No new radius or shadow values are being introduced — `rounded-input` (14px) / `rounded-button` (16px) / `rounded-card` (18px) / `rounded-card-lg` (22px) and `shadow-soft` / `shadow-soft-md` (both already defined in `tailwind.config.ts`) fully cover every use case above. This is deliberate: the existing shadow/radius scale is genuinely well-judged (soft, low-opacity, "mimics Apple HIG depth cues" per its own code comment) and doesn't need replacing, only using more widely.

---

## PART 7 — BUTTONS

No change to the existing primary/secondary button classes (`page.tsx:120-131`) — they're correct:
```
Primary:   rounded-button bg-brand px-6 py-3 text-sm font-semibold text-white shadow-soft-md hover:bg-brand-dark
Secondary: rounded-button border border-hairline-strong bg-white px-6 py-3 text-sm font-semibold text-ink hover:border-brand hover:text-brand
```
**One addition**: a slightly larger hero-scale variant for the two highest-stakes CTAs (hero primary, final-CTA primary only) — `px-7 py-3.5 text-base` instead of `px-6 py-3 text-sm` — so the two bookend moments of the page feel weightier than an inline card button, without introducing a whole new button component.

---

## PART 8 — COLOR & SURFACES

No new color tokens — `tailwind.config.ts`'s existing `brand` / `ink` / `surface` / `hairline` scales are complete and already shared correctly with `this repo (vendor-portal/)`. The only change is **usage**, not the palette itself:

- Hero: white (unchanged)
- Why Platform: white (unchanged)
- How It Works: `surface-canvas` (#F8F9FB) full-bleed — already used, correct, keep
- Browse by Category: white
- Final CTA: **new usage** — a genuine dark ground. Since no dark-charcoal token currently exists in the config, the closest correct answer is to reuse `ink` (#0B0C0F, already the text-primary color) *as a background* for this one section, with white/`ink-disabled`-tier text on top and the brand orange as the sole warm accent against it. This avoids inventing a brand-new color while giving the closing section genuine visual contrast from the rest of the (all-white) page.

---

## PART 9 — MOTION

| Element | Trigger | Behavior | Duration | Reduced-motion fallback |
|---|---|---|---|---|
| Hero text + device frame | Page load | Fade + 12px upward translate, frame slightly delayed (100ms) after text | 400ms ease-out | Instant, no transform |
| Category card | Hover (desktop only) | Scale 1.03 + shadow-soft → shadow-soft-md | 200ms ease-out | N/A (hover-only, no motion needed for touch) |
| Category rail | Scroll | Native `scroll-snap`, no JS-driven animation | N/A | N/A — CSS scroll-snap has no motion-preference concern |
| Section headings | Scroll into view | Fade + 8px upward translate | 350ms ease-out | Instant, no transform |
| How It Works step screenshots | Scroll into view | Staggered fade-in, 80ms delay between siblings | 350ms ease-out each | Instant, no stagger |
| Final CTA device frame | Scroll into view | Fade + slight scale (0.97 → 1) | 400ms ease-out | Instant |

All motion gated behind a single check against `prefers-reduced-motion: reduce` (the site's `globals.css` already has a global reduced-motion rule collapsing all animation/transition durations to `0.01ms` — every recommendation above inherits that existing guard automatically, no new accessibility work required). Nothing here uses parallax, autoplay, or looping animation — every effect fires once, tied to a real user action (load or scroll-into-view), matching the restrained posture the brief asked for.

---

## PART 10 — DESKTOP / TABLET / MOBILE BEHAVIOR

| Section | Desktop (≥1024px) | Tablet (768-1023px) | Mobile (<768px) |
|---|---|---|---|
| Hero | 2-col: text 45% / device frame 50%, frame bleeds past container edge | 2-col, tighter ratio (50/50), no bleed | Stacked: text, then frame capped at 280px wide, centered |
| Why Platform | 2-col card grid | 2-col (unchanged from current `sm:grid-cols-2`) | 1-col, full-width cards |
| How It Works | Horizontal step rail, connecting line, 4-5 steps visible without scroll | Same rail, may require slight horizontal scroll for 5-step vendor row | Vertical stack, connecting line becomes vertical, screenshots shrink to ~120px |
| Browse by Category | Rail shows ~6 cards, edge-fade signals more | Rail shows ~4 cards | Full-width native touch-scroll, ~1.3 cards visible (partial next card signals "more") |
| Final CTA | 2-col: copy+badges 50% / device frame 50% | Same, tighter ratio | Stacked: copy, badges, frame below |
| Navigation | Full 5-link nav + both CTAs visible | Full nav, may compress link spacing | Existing hamburger drawer (unchanged — already correct) |

---

## PART 11 — WHAT STAYS TECHNICALLY UNCHANGED

**Explicitly unchanged (confirmed by reading the actual code, not assumed):**
- `lib/siteContent.ts` — `getPublishedSiteContent()` / `sectionOrFallback()` — CMS content-retrieval pipeline is untouched
- The `siteContent/home` Firestore document shape and the CMS editor at `app/cms/[sectionId]` — no backend change
- `RichText.tsx` — reused as-is for the hero heading/paragraph (it already renders the correct scale); no rewrite
- All Firebase Functions, Firestore rules, Storage rules — zero backend changes anywhere in this plan
- Routing / page structure for all other 13 pages — this plan is homepage-only, as scoped
- `AppBadges.tsx` — reused as-is (already correctly matches Apple/Google's own badge guidelines); only its container sizing in the Final CTA context changes, not the component itself
- `SiteHeader.tsx` mobile drawer mechanism, focus handling, `SiteFooter.tsx` — unchanged

**Requires frontend/design changes (exact files):**

| File | Change | Type |
|---|---|---|
| `src/app/(marketing)/page.tsx` | Restructure hero markup (2-col), swap category grid for new rail component, rebuild Why Platform to 2-col + icons, rebuild How It Works to use screenshot rail, rebuild Final CTA to dark full-bleed 2-col, route all `<h2>` through `heading-lg` scale | Structural + styling |
| `src/components/SiteHeader.tsx` | Add mark/monogram next to wordmark, trim nav array from 7 to 5 items | Structural + asset |
| `tailwind.config.ts` | Add one new type scale entry (`display-2xl`) for the hero-only headline size — everything else already exists | Styling (token addition only) |
| `src/app/globals.css` | Add scroll-into-view fade/translate keyframes + scroll-snap utility classes for the category rail (already has the reduced-motion guard, extend it to cover new animations) | Styling |

---

## PART 12 — NEW COMPONENTS

| Component | Purpose | Justification for being separate |
|---|---|---|
| `DeviceFrame` | Wraps a screenshot in a phone outline; props: `screenshot`, `size` ('lg' for hero/CTA, 'sm' for step-rail) | Reused in 3 distinct places (hero, CTA, step rail small variant) — a single source of truth for frame styling |
| `CategoryRail` | Horizontal scroll-snap container + card rendering for the category section | Self-contained scroll/snap logic, cleanly separable from page layout |
| `CategoryCard` | Single category tile: image, label | Used only inside `CategoryRail`, but kept separate for readability/testability |
| `StepRail` | Renders a numbered, connected step sequence with screenshot anchors (replaces current inline `StepFlow` function in `page.tsx`) | Currently an inline function in `page.tsx` (lines 68-85) — promoting it to a real component is warranted since it's growing more complex (screenshot + connecting line), not because of an arbitrary rule about extracting things |

**Not creating**: a generic `SectionHeading` wrapper, a `DownloadCTA` component, or any other abstraction not directly justified above — three of the current four "Why Platform/How It Works/Category/CTA" sections stay as inline JSX inside `page.tsx`, matching how the codebase already works, since none of them are reused elsewhere.

---

## PART 13 — ASSETS REQUIRED

**Must be created/sourced (none of these exist in the repo today — confirmed, not assumed):**
1. Real screenshots: customer chat-before-order thread (hero), order-tracking OR vendor-storefront screen (final CTA, must differ from hero's shot), 4 customer-flow screens + 5 vendor-flow screens (How It Works rail) — **9-11 total real screenshots**
2. Category photography — 12 images (one per real category from `DAY_ONE_CATEGORIES`), consistent aspect ratio and lighting/treatment. Stock photography is an acceptable starting point; can be replaced with real vendor-submitted photos later once that data exists.
3. Brand mark/monogram for the header (small, one-time asset — a designer or the Founder's brand resource can produce this quickly since it's just a lockup, not a full identity system)
4. Device-frame graphic asset — can be built purely in CSS/SVG (a rounded-rect bezel) rather than needing a bitmap "phone mockup" image; recommend this route since it scales cleanly at any resolution and needs no image asset at all

**For design approval before real assets exist**: solid-color placeholder blocks in the exact card/frame dimensions specified above are sufficient to validate the *layout* with the Founder before committing to a photo shoot or screenshot capture session — this avoids delaying approval on an asset pipeline that takes longer than a layout review.

---

## PART 14 — BEFORE / AFTER

| Current | Proposed |
|---|---|
| Hero: text-only, ~60% of the section is empty white space | Hero: asymmetric text + real device-frame product shot, no dead space |
| Categories: 12 grey bordered pills, settings-panel feel | Categories: horizontal image rail, browse/discover feel |
| How It Works: 9 identical numbered text boxes | How It Works: numbered rail anchored to real product screenshots |
| Why Platform: 4 identical icon-less cards | Why Platform: 2 larger cards with icons, clearer hierarchy |
| Final CTA: "Ready to start?" on white, two small store badges | Final CTA: dark full-bleed section, larger badges, second device frame, clearer single headline |
| Section headings: hand-rolled `text-2xl`, drifting from the system | Section headings: uniformly routed through the existing `heading-lg` scale already defined in `RichText.tsx` |
| Navigation: text wordmark only, 7 links | Navigation: wordmark + mark, 5 links |

---

## PART 15 — FINAL RECOMMENDATION

### A. What is wrong
1. Zero real product imagery anywhere on the page — the single largest gap
2. The category section is genuinely mis-designed for its purpose (browse/discover), not just under-styled — correctly the client's top complaint
3. Hero wastes the majority of its space and leads with a generic, undifferentiated headline
4. "How It Works" describes the product in text where it should demonstrate it in screenshots
5. Section headings inconsistently apply a type scale that already exists correctly elsewhere in the same codebase
6. Final CTA is the least effortful section on the page despite being the last thing a visitor sees

### B. What should remain
- The entire design-token layer: colors, radii, shadows, the `RichText.tsx` heading scale, button styling — all already correct and shared properly with the mobile app and vendor portal
- `SiteHeader.tsx`'s mobile drawer mechanism and accessibility work — genuinely well-built, no changes needed to its logic
- `AppBadges.tsx` — matches official platform guidelines, reused as-is
- The CMS content pipeline, Firestore/Storage rules, all backend functions — none of this needs to change
- The "How It Works" two-flow (Customer/Vendor) structure and the "Browse → Chat → Order → Receive" journey itself — the *shape* of the story is right, only its presentation needs work
- The real category taxonomy (`DAY_ONE_CATEGORIES`) — not renaming or restructuring these

### C. What should be redesigned
Hero composition, Why Platform card treatment, How It Works presentation, Vendor Categories section (complete redesign), Final CTA composition, navigation visual weight, and consistent application of the existing type scale to hardcoded headings.

### D. What should be removed
- The conditional "App Screenshots" section (`page.tsx:181-193`) and its `APP_SCREENSHOTS_AVAILABLE` flag — superseded by weaving real screenshots into the Hero and How It Works instead of isolating them in their own block
- The generic "Ready to start?" headline (replaced with something more specific, final wording via CMS/the Founder)
- 2 of the 7 primary nav links (FAQ, About) — already available in the footer, no information is lost

### E. What should be added
- One brand mark/monogram asset (header)
- Category photography (12 images)
- Real product screenshots (9-11 across hero, CTA, and step rail)
- Three new small components (`DeviceFrame`, `CategoryRail`/`CategoryCard`, `StepRail`) — no more than that; deliberately not over-abstracting sections used only once

### F. Proposed homepage structure (final)
1. Navigation
2. Hero (device frame)
3. Why Platform (2-col, icon-supported)
4. How It Works (screenshot-anchored rail)
5. Browse by Category (horizontal image rail)
6. Final CTA (dark, two-sided close)
7. Footer

### G. Implementation scope: **MEDIUM**

Not "high," because:
- Zero backend/CMS changes
- Zero new design tokens beyond one new type-scale step
- Only 3 new components, all small and single-purpose
- The existing responsive grid system, button styles, and shadow/radius scale are reused wholesale, not replaced

Not "low," because:
- The category rail needs real scroll-snap behavior + touch testing across breakpoints
- 9-11 real product screenshots need to be captured/selected and optimized before the How It Works and CTA sections can ship in their final form (layout can be approved and built against placeholders first, then swapped)
- Category photography (12 images) needs sourcing before that section ships in final form (same placeholder-first approach applies)

Realistic estimate: **layout + component build, 3-4 days once this direction is approved; final polish once real assets land, 1-2 additional days.** The two asset-dependent sections (How It Works, Categories) can each ship with the current text/pill treatment temporarily if assets lag, without blocking the rest of the redesign from going live.

### H. Approval checkpoint

**This document is a design direction only. No code has been written, and none should be until this direction — and specifically the category-rail approach (Option B), the hero's chosen product screen, and the asset list in Part 13 — is reviewed and approved.** Once approved, implementation proceeds section by section, starting with whichever section the Founder wants to see first (the category redesign is the most likely candidate, since it's the section she named directly).
