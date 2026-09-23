# Platform Homepage — Design Review & Redesign Direction

**Prepared:** 27 August 2026
**Scope:** `this repo (website/)` homepage only — `src/app/(marketing)/page.tsx`
**Reference:** `runway.com/pricing` used only as a quality reference. The proposed design does not copy Runway's layout, colours, or content.

**Important:** This is a design direction only. No code has been changed as part of this review.

---

## 1. Overall assessment

The current homepage isn't badly built from a technical standpoint. The existing components, responsive behaviour, design tokens and CMS setup are generally in good shape.

The main problem is the **composition of the page**.

At the moment, most of the homepage is made up of text, borders and small cards. There is very little visual evidence of the actual product, and some of the sections feel more like a functional prototype than a finished marketplace.

The biggest issues are:

1. The hero has too much unused space and doesn't show the product.
2. The current feature cards look like a generic SaaS feature grid.
3. The "How It Works" section explains the product but doesn't really show it.
4. The category section looks like a filter/settings panel instead of something users would browse.
5. The final CTA feels like an afterthought.
6. Some headings aren't following the typography system that already exists in the codebase.
7. There are currently no real visual assets in the repository to support a more product-led homepage.

The good news is that I don't think the underlying design system needs to be replaced. The colours, radii, shadows, buttons and typography are already reasonably well defined.

This is primarily a **layout, hierarchy and asset problem**.

---

# 2. What is currently in the codebase

Before changing the design, I checked the actual repository rather than assuming what assets or components were available.

### Assets

`this repo (website/)/public/` is currently empty.

There are no photographs, category images or icon assets in the website repository. `lucide-react` is already installed (`v0.475.0`) and is currently the only real visual icon source.

There also aren't category images sitting somewhere else in the product that can simply be reused.

The mobile app's category list is defined in:

`multivendor-marketplace-mobile/expo/constants/categories.ts`

through `DAY_ONE_CATEGORIES`.

It contains the 12 current categories:

* Food & Catering
* Fashion
* Beauty Tools
* Home & Living
* Electronics Repair
* Baby & Kids
* Bags & Accessories
* Phone Accessories
* Art & Handmade
* Books & Stationery
* Digital Products
* Safe Verified Services

There is a `CategoryDisplay` interface with an optional `image?: string`, but there are no actual category images being populated anywhere in the app.

So if the category section is going to become image-led, those images will need to be sourced separately.

### Typography

The good part is that there is already a proper typography system.

`multivendor-marketplace-mobile/expo/constants/theme.ts` defines:

* `displayHero` — 34 / 800 / -0.8
* `displayTitle` — 30 / 800 / -0.6
* `pageTitle` — 24 / 700 / -0.4
* `sectionTitle` — 18 / 700 / -0.2
* `cardTitle` — 16 / 600 / -0.1
* `body` — 15 / 400
* `sectionLabel` — 12 / 700 / uppercase

The website's `RichText.tsx` already follows this direction:

* `h1`: `text-4xl md:text-5xl font-extrabold tracking-[-0.02em]`
* `h2`: `text-2xl md:text-3xl font-bold tracking-[-0.015em]`

The issue is that the hardcoded headings in `page.tsx` don't consistently follow this.

For example, sections such as "Why Platform", "How it works", "Vendor Categories" and "Ready to start?" currently use:

```tsx
text-2xl font-bold tracking-[-0.015em] text-ink
```

They are missing the responsive `md:text-3xl` step already used by `RichText`.

So I don't think we need a completely new typography system. We just need to use the existing one consistently and add one larger marketing-specific hero size.

---

# 3. Homepage review

## 3.1 Navigation

### Current

The header is in `components/SiteHeader.tsx`.

It already has:

* Sticky positioning
* Translucent background
* Desktop navigation
* Mobile drawer
* Focus handling
* Escape-to-close
* Body scroll locking
* 48px tap targets
* Vendor login
* Become a Vendor CTA

The mobile implementation is actually good and doesn't need to be rebuilt.

### What feels off

The wordmark is currently just the text "Platform". There isn't a small visual mark that helps establish the brand.

There are also seven primary links:

`Features, Pricing, Vendors, Customers, FAQ, About, Contact`

That's more navigation than the homepage really needs.

FAQ and About are already available in the footer, so I would move those out of the primary navigation.

### Proposed change

Primary navigation:

`Features · Pricing · Vendors · Customers · Contact`

Add a small Platform mark/monogram beside the wordmark.

A simple geometric "L" inside a rounded square would be enough. This doesn't need to become a full branding exercise.

The current `bg-white/90 backdrop-blur` header treatment is fine and can stay.

I would also keep the existing mobile drawer and its accessibility behaviour unchanged.

---

# 4. Hero

## Current

The hero currently has a white background and a `max-w-2xl` text block.

The basic structure is:

* Heading
* Paragraph
* Become a Vendor
* Shop on Platform

The problem is that the text only occupies roughly the left side of the desktop container. The rest of the hero is just empty white space.

That space could be doing a lot more work.

More importantly, the hero doesn't show anything from the actual product.

### Proposed direction

Move to a two-column layout on desktop.

**Left:** headline, supporting copy and CTAs.

**Right:** a real product screenshot inside a phone/device frame.

The screenshot should show the **customer chat-before-order experience**.

That's one of the strongest product moments available because it demonstrates something more specific than generic marketplace browsing.

The hero should lead with the actual product mechanism rather than a generic marketplace statement.

The current:

> "Buy and sell directly."

is accurate, but it could describe almost any marketplace.

The direction should be closer to something like:

> "Talk to the vendor before you buy."

or

> "Local vendors. Direct chat. Real orders."

Those are examples of the direction, not final copy. The final headline can continue to come from the CMS and be approved by the Founder.

### CTA

I would keep the existing primary/secondary button pattern.

However, I would put:

**Shop on Platform** first.

The customer acquisition path is the broader funnel, while becoming a vendor is the secondary path.

The primary hero button can use slightly more padding:

`px-7 py-3.5 text-base`

while the secondary button remains closer to the current sizing.

### Responsive behaviour

Desktop:

* roughly 45% text
* roughly 50% device visual
* device can slightly extend beyond the right side of the container

Tablet:

* tighter 50/50 layout
* no intentional bleed

Mobile:

* text first
* product frame underneath
* phone capped around 280px wide
* centred

---

# 5. Why Platform

## Current

The section contains four identical cards:

* Verified Vendors
* Chat Before Ordering
* Marketplace Orders
* Built for Local Businesses

They're currently displayed in a four-column grid on large screens.

Each card has a border, shadow, title and short description.

### Problem

The content itself is useful, but the presentation is very generic.

Four identical cards with the same size and treatment immediately looks like a standard SaaS template.

There also isn't much visual difference between the four ideas.

### Proposed direction

Use a two-column grid on desktop and one column on mobile.

Each card becomes larger and gets a simple icon.

Suggested icons from the existing `lucide-react` dependency:

* Verified Vendors → `ShieldCheck`
* Chat Before Ordering → `MessageCircle`
* Marketplace Orders → `PackageCheck`
* Built for Local Businesses → `Store`

Put each icon inside a small brand-tinted circle using the existing `bg-brand-light` treatment.

This also builds on the number-badge treatment already used in `StepFlow`, so it doesn't introduce a completely unrelated visual language.

The heading could become more customer-focused:

**"Why customers choose Platform"**

or something similar.

Again, final copy can remain CMS-controlled.

---

# 6. How It Works

## Current

There are two flows:

### Customers

4 steps.

### Vendors

5 steps.

The two flows themselves are correct. I wouldn't change the underlying journey.

The problem is how they're presented.

At the moment, the nine steps are essentially small numbered boxes containing text.

That makes the section feel like a flowchart.

### Proposed direction

Keep the two flows, but make them visual.

For customers:

1. Browse
2. Chat
3. Order
4. Receive / Track

For vendors:

1. Register
2. Verification
3. Storefront / Catalog
4. Receive Orders
5. Manage / Dashboard

Each step gets a small screenshot of the relevant product screen.

The existing numbered badges can stay.

Instead of having nine isolated cards, connect the steps with a thin horizontal line running through the numbered badges.

That makes the section feel like one journey rather than a collection of cards.

### Desktop

Horizontal rail.

### Tablet

Still horizontal, with some horizontal scrolling if needed.

### Mobile

Stack vertically.

The connecting line becomes vertical and the screenshots become smaller, around 120px wide.

The screenshots don't need full phone mockups here. A simple rounded screenshot crop with a border is enough.

The full phone/device treatment should be reserved for the hero and final CTA so it doesn't become repetitive.

### Asset dependency

This section needs real product screenshots to reach the intended final design.

If those screenshots aren't ready yet, the current text treatment can temporarily remain while the rest of the redesign is implemented.

I would not block the entire homepage on screenshot production.

---

# 7. Browse by Category

This is the section that needs the biggest visual change.

## Current

The 12 categories are shown as small bordered boxes:

* Food & Catering
* Fashion
* Beauty Tools
* Home & Living
* Electronics Repair
* Baby & Kids
* Bags & Accessories
* Phone Accessories
* Art & Handmade
* Books & Stationery
* Digital Products
* Safe Verified Services

Technically, the implementation is fine.

Visually, though, it looks much more like a filter or settings interface than a marketplace discovery section.

There is nothing that tells the user these are things they can explore.

### Proposed direction

I considered three approaches.

### Option A — Image grid

Use image-led cards in a 2 / 3 / 4-column grid.

Each card would have:

* Category image
* Category name
* Optional vendor count, if a real count is available

This would work, but it requires sourcing 12 images and puts a lot of content on the page at once.

### Option B — Horizontal category rail

**Recommended.**

Use a horizontally scrollable row of image-led cards.

Each card would be approximately:

* 180–200px wide
* 240px tall
* roughly 4:5 image treatment
* 18px card radius

The image occupies most of the card, with the category name underneath on a clean surface.

Desktop can show around 5–6 cards.

Tablet around 4.

Mobile shows roughly 1.3 cards, with part of the next card visible to make it obvious that the row continues.

Use CSS scroll-snap rather than building unnecessary JavaScript carousel behaviour.

This also gives the homepage a useful mobile interaction that it currently doesn't have.

### Option C — Featured asymmetric grid

One category gets a larger tile while the others sit around it.

This could look good, but there isn't currently a reason to prioritise one category over the other eleven.

Unless there is an editorial or business reason to feature a particular category, I wouldn't use this.

### Recommendation

**Option B.**

I would rename the section from:

**Vendor Categories**

to something more shopper-oriented, such as:

**What are you looking for?**

or:

**Browse by category**

The category taxonomy itself should not change.

### Interaction

Desktop hover:

* slight scale, around 1.03
* small shadow increase
* subtle image darkening

Mobile:

* no hover treatment
* tap takes the user into the category

### Vendor counts

I would not add numbers unless the backend actually provides reliable per-category counts.

The `vendors` collection can be queried by category, but whether those counts should be exposed on the homepage is a separate product/data decision.

No numbers should be invented for visual purposes.

---

# 8. App Screenshots section

There is already an `APP_SCREENSHOTS_AVAILABLE` flag in:

`lib/appScreenshots.ts`

It is currently `false`.

That means the existing screenshot section doesn't render.

The reason is sensible: the old implementation apparently showed empty "Coming soon" boxes, which made the page look unfinished.

I would keep that section disabled and ultimately remove it.

With the new design, screenshots are more useful when they are part of the actual story:

* Hero
* How It Works
* Final CTA

There isn't much benefit in adding another standalone screenshot grid at the bottom.

---

# 9. Final CTA

## Current

The page ends with:

> "Ready to start?"

and two store badges on a white background.

It works functionally, but it feels like the minimum possible closing section.

### Proposed direction

Make this a strong visual ending.

Use the existing `ink` colour (`#0B0C0F`) as the background instead of introducing another colour token.

Desktop:

**Left**

* headline
* supporting copy
* App Store / Google Play badges
* secondary vendor link if needed

**Right**

* a second product device frame

The screenshot should be different from the hero.

For example:

* Hero → chat-before-order
* Final CTA → order tracking or vendor storefront

That gives the page two different product moments rather than repeating the same image.

### Headline

Instead of:

> "Ready to start?"

the CTA should explain what the visitor is actually being asked to do.

Something around:

**"Download Platform"**

would be much clearer.

The vendor path can remain a secondary text link rather than another competing button.

### Mobile

Stack:

1. Heading
2. Supporting copy
3. Store badges
4. Device frame

---

# 10. Proposed homepage structure

The finished homepage should be:

1. **Navigation**
2. **Hero**

   * Product screenshot/device frame
3. **Why Platform**

   * Two-column feature cards
4. **How It Works**

   * Customer flow
   * Vendor flow
   * Product screenshots
5. **Browse by Category**

   * Horizontal image rail
6. **Final CTA**

   * Dark background
   * Download CTA
   * Product screenshot
7. **Footer**

No additional sections are needed.

I don't recommend adding:

* fake testimonials
* invented customer numbers
* generic "trusted by" logos
* made-up statistics
* another trust section
* a separate vendor-growth section

Verification can already be explained through the existing "Verified Vendors" content and the `/vendors` page.

Vendor subscription/growth information already has a better home on `/vendors` and `/pricing`.

---

# 11. Product screenshots and visual storytelling

The page should tell the product story through actual UI rather than repeatedly describing it.

The intended journey is already present in the product:

**Discover → Explore → Chat → Order → Manage**

For the customer flow:

* Browse
* Chat
* Order confirmation
* Order tracking / receiving

For the vendor flow:

* Registration
* Verification
* Storefront/catalog
* Orders
* Dashboard

The important thing is not to create another "product journey" section.

The existing How It Works section is already the right place for this story. It just needs to become visual.

---

# 12. Typography

I wouldn't replace the existing typography system.

I'd formalise the following marketing sizes:

| Token         | Desktop | Mobile | Weight |
| ------------- | ------: | -----: | -----: |
| `display-2xl` |    56px |   36px |    800 |
| `display-xl`  |    48px |   36px |    800 |
| `heading-lg`  |    30px |   24px |    700 |
| `heading-md`  |    20px |   20px |    700 |
| `card-title`  |    16px |   16px |    600 |
| `body`        |    16px |   15px |    400 |
| `label`       |    12px |   12px |    700 |

`display-2xl` is the only genuinely new size.

It should be reserved for the hero.

`display-xl` is already effectively what `RichText` uses for the h1.

`heading-lg` is also already represented by the existing `RichText` h2 styling.

The main change is making the hardcoded homepage headings follow the same scale.

---

# 13. Cards

The existing radius and shadow system is good enough.

I would keep:

* `rounded-button`
* `rounded-input`
* `rounded-card`
* `rounded-card-lg`
* `shadow-soft`
* `shadow-soft-md`

### Feature cards

* `rounded-card`
* `shadow-soft`
* no heavy border
* icon
* heading
* body

### Category cards

* `rounded-card`
* `shadow-soft`
* image
* category name
* `shadow-soft-md` on hover

### Step cards

* `rounded-card`
* `border-hairline`
* `shadow-soft`
* screenshot
* number badge
* label

There is no need to introduce a new collection of arbitrary radius or shadow values.

---

# 14. Buttons

The existing button styling is good and should remain.

Current primary:

```text
rounded-button bg-brand px-6 py-3 text-sm font-semibold text-white shadow-soft-md hover:bg-brand-dark
```

Current secondary:

```text
rounded-button border border-hairline-strong bg-white px-6 py-3 text-sm font-semibold text-ink hover:border-brand hover:text-brand
```

For the hero and final CTA only, use a slightly larger version:

```text
px-7 py-3.5 text-base
```

This gives the two main conversion points more weight without creating a completely separate button system.

---

# 15. Colour and surfaces

No new colour palette is needed.

Keep the existing:

* `brand`
* `brand-light`
* `ink`
* `surface`
* `surface-canvas`
* `hairline`

The page can be structured around:

### Hero

White

### Why Platform

White

### How It Works

`surface-canvas` (`#F8F9FB`)

### Browse by Category

White

### Final CTA

`ink` (`#0B0C0F`)

Using `ink` as the final CTA background gives the page the contrast it currently lacks without introducing another brand colour.

---

# 16. Motion

The motion should stay restrained.

### Hero

On load:

* fade in
* 12px upward movement
* device frame delayed by around 100ms

Duration:

`400ms ease-out`

### Category cards

Desktop hover:

* scale to approximately 1.03
* shadow lift

Around `200ms ease-out`.

### Section headings

On entering the viewport:

* fade
* 8px upward movement
* around `350ms`

### How It Works screenshots

Staggered fade:

* around 80ms between siblings
* around 350ms each

### Final CTA device

On entering the viewport:

* fade
* subtle scale from 0.97 → 1
* around `400ms`

Nothing here needs parallax, autoplay or looping animation.

The existing `globals.css` already has a reduced-motion rule that collapses animation/transition durations to essentially zero, so the new animations should inherit that behaviour.

---

# 17. Responsive behaviour

| Section      | Desktop                 | Tablet                 | Mobile          |
| ------------ | ----------------------- | ----------------------- | --------------- |
| Hero         | 2-column, text + device | tighter 2-column        | stacked          |
| Why Platform  | 2-column cards          | 2-column                | 1-column         |
| How It Works | horizontal rail         | horizontal rail/scroll  | vertical stack   |
| Categories   | ~6 cards visible        | ~4 cards                | ~1.3 cards       |
| Final CTA    | 2-column                | tighter 2-column        | stacked          |
| Navigation   | 5 links                 | compressed 5 links      | existing drawer  |

The mobile drawer itself should not be rebuilt.

---

# 18. Files that should remain untouched

The following should not need changes:

* `lib/siteContent.ts`
* `getPublishedSiteContent()`
* `sectionOrFallback()`
* CMS content structure
* `siteContent/home` Firestore document
* Firebase Functions
* Firestore rules
* Storage rules
* Other website pages
* `RichText.tsx`
* `AppBadges.tsx`
* `SiteFooter.tsx`
* existing mobile navigation/drawer logic

This is a homepage redesign, not a backend or CMS redesign.

---

# 19. Files that will need changes

| File                             | Change                                                             |
| -------------------------------- | ------------------------------------------------------------------- |
| `src/app/(marketing)/page.tsx`   | Hero, feature cards, How It Works, category section and final CTA  |
| `src/components/SiteHeader.tsx`  | Add mark and reduce primary navigation                              |
| `tailwind.config.ts`             | Add `display-2xl`                                                   |
| `src/app/globals.css`            | Add/reuse animation and scroll-snap styling                         |

---

# 20. Components

I would keep the component additions fairly small.

### `DeviceFrame`

Reusable phone/device wrapper.

Used for:

* Hero
* Final CTA
* potentially the smaller step screenshots

Props can include:

* screenshot
* size (`lg` / `sm`)

### `CategoryRail`

Handles the horizontal category scroll/snap behaviour.

### `CategoryCard`

The individual category tile.

### `StepRail`

The existing `StepFlow` function is currently inline in `page.tsx`.

Once screenshots and connecting lines are added, it becomes complex enough to justify extracting it.

I wouldn't create generic components just for the sake of abstraction.

No separate `SectionHeading`, `DownloadCTA`, etc. is necessary at this stage.

---

# 21. Assets required

There are three main asset requirements.

### Product screenshots

Approximately 9–11 screenshots:

**Hero**

* Customer chat-before-order

**Customer flow**

* Browse
* Chat
* Order confirmation
* Order tracking / receiving

**Vendor flow**

* Registration
* Verification upload
* Storefront/catalog
* Order received
* Dashboard

**Final CTA**

* Order tracking or vendor storefront

The final CTA screenshot should be different from the hero screenshot.

### Category photography

12 images, one for each existing category.

They should ideally have a consistent:

* aspect ratio
* lighting style
* crop
* overall visual treatment

Stock photography is fine as a first version. These can later be replaced with real vendor/catalog imagery once the product has enough data.

### Brand mark

A small Platform monogram/mark for the header.

This can be supplied by the brand side or designed as a simple geometric mark.

### Device frame

This does not need to be a bitmap asset.

A CSS/SVG phone frame is preferable because it scales cleanly and doesn't add another image dependency.

---

# 22. Placeholder approach

The layout shouldn't have to wait for all the final assets.

For initial approval, we can use simple placeholders in the correct:

* dimensions
* aspect ratios
* spacing
* device-frame sizes

That allows the layout itself to be approved first.

Once screenshots and photography are ready, the real assets can be dropped in without changing the overall composition.

---

# 23. Before vs. after

| Current                                       | Proposed                                       |
| ---------------------------------------------- | ----------------------------------------------- |
| Text-only hero with large unused area          | Text + product device frame                     |
| Generic "Buy and sell directly" positioning    | Product-specific headline direction             |
| Four identical feature cards                   | Larger two-column cards with icons              |
| Nine numbered text boxes                       | Screenshot-driven customer/vendor flows         |
| 12 grey category boxes                         | Image-led horizontal category rail              |
| App screenshots hidden behind a flag           | Screenshots integrated into the actual story    |
| "Ready to start?" on white                     | Dark, product-led final CTA                     |
| Small store badges                             | Larger badges in a dedicated download section   |
| Seven primary nav links                        | Five curated links + brand mark                 |
| Hardcoded headings using inconsistent sizing   | Existing heading scale applied consistently     |

---

# 24. What I would keep

There are several things that don't need to be reinvented:

* Existing colour tokens
* Existing radius system
* Existing shadows
* Existing button styles
* Existing `RichText` typography
* CMS content pipeline
* Firebase/backend
* Mobile navigation implementation
* Footer
* App store badge component
* Existing category names
* Customer/vendor flow structure

The foundation is usable.

The redesign is mainly about **making the homepage feel like a real product rather than a collection of functional sections**.

---

# 25. What should be removed

I would remove or retire:

* The standalone conditional App Screenshots section
* `APP_SCREENSHOTS_AVAILABLE` once screenshots are integrated elsewhere
* The generic "Ready to start?" heading
* FAQ from the primary navigation
* About from the primary navigation

Nothing is being removed from the website itself unnecessarily; FAQ and About can remain in the footer.

---

# 26. Implementation scope

I would call this **medium scope**.

It's not a rebuild.

There are no:

* backend changes
* Firebase changes
* CMS changes
* authentication changes
* new page architecture
* major design-system changes

But it isn't a small styling pass either.

The homepage needs:

* a new hero composition
* a new category rail
* new feature-card treatment
* a new How It Works presentation
* a new final CTA
* responsive adjustments
* new visual assets
* a few new components
* some motion work

A reasonable implementation estimate is:

**3–4 days** for the layout/component work once the direction is approved.

Then approximately:

**1–2 additional days** for final polish once the real screenshots and category imagery are available.

The asset-dependent sections can be built against placeholders first.

---

# 27. Approval checkpoint

Before implementation starts, I would specifically get approval on three things:

1. **The category direction**

   * Recommended: horizontal image rail / Option B

2. **The hero product screen**

   * Recommended: customer chat-before-order

3. **The required assets**

   * Product screenshots
   * Category imagery
   * Platform mark

Once those are approved, implementation can proceed section by section.

The category section is probably the best first section to build because it is the most obvious visual departure from the current homepage and directly addresses the main feedback.

---

# Final recommendation

The homepage doesn't need more sections. It needs **better use of the sections it already has**.

The overall direction should be:

**Show the product → explain the value → demonstrate the journey → let people browse → finish with a clear download CTA.**

The current structure is already close to that.

What is missing is the visual execution.

The strongest changes are therefore:

* Put a real product screen in the hero.
* Turn the feature grid into larger, more intentional cards.
* Show the customer/vendor journeys instead of only describing them.
* Replace the category pills with an image-led horizontal rail.
* Give the final CTA a strong dark treatment and another product moment.
* Keep the existing design system rather than replacing it.
* Keep the CMS/backend untouched.
* Use real assets rather than fabricated content or social proof.

That should make the homepage feel considerably more finished without turning the redesign into a full website rebuild.
