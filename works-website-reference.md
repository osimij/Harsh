# Cathy Dolle – "Folio Template" Case-Study Page
### Pixel-perfect rebuild specification

**URL:** https://www.cathydolle.com/case-study/folio-template  
**Stack on the original:** Next.js (App Router) + Tailwind CSS + Sanity CMS + Lenis (smooth scroll).  
**Scope:** This document describes **the case-study page** (`/case-study/[slug]`), not the homepage or shop.

---

## 1. Global Concept

The page is built like a **white "card"** floating inside a **thin black frame**. The black frame is created by giving `<body>` a horizontal margin equal to one design unit, while the body background is black. All page content (header, white case-study section, footer, fixed UI) lives **inside** that white card.

**Visual mood:** minimalist editorial portfolio — lots of white-space, very small typography (11 px everywhere), thin grayscale UI, mix-blend-difference for media controls, no bright colors at all.

---

## 2. Design Tokens

### 2.1 Colors

| Token | Value | Usage |
|---|---|---|
| `--bg-frame` | `#000000` | `<body>` background (the thin black border) |
| `--bg-card` | `#FFFFFF` | The white case-study section |
| `--text-primary` | `#000000` | All copy, links, labels |
| `--text-muted` | `rgba(0,0,0,.6)` | About / description paragraph (`opacity: .6`) |
| `--ui-control-text` | `#FFFFFF` + `mix-blend-mode: difference` | Video player labels (play/mute/timecodes) |
| `--rule` | `rgba(0,0,0,.2)` | Thin horizontal rule next to "Scroll Down to Next Project" |
| `--placeholder` | `bg-gray-400` (#9CA3AF) | Image/video placeholder before media loads |
| `--overlay-bg` | `rgba(255,255,255,.9)` | Lightbox overlay background |
| `--overlay-control-bg` | `rgba(0,0,0,.5)` | Inner control-panel background inside lightbox |

`:root` declares only `--background:#fff; --foreground:#171717;` but those are NOT used on the case-study page itself — the page forces black/white.

### 2.2 Typography

- **Font family:** `neuemontreal` (loaded as 4 OTF files: weights 300, 400, 500, 700) with a system fallback `"neuemontreal Fallback"`.  
  Available weights: `300 / 400 / 500 / 700`.  
  Used on this page: **400** (body copy, role items) and **500** (everything labelled / uppercase).

- **Base font-size:** `11px` for *everything visible* on this page (headings, nav, footer, scroll prompts, time-codes…). There is **no large hero type** — the design intentionally keeps every text element at 11 px.

- **Line-height:** `110%` for the case-study text wrapper; some specifics:  
  - `Cathy Dolle` (logo H1) → `line-height: 16.5px`  
  - Counter "100 %" → `13px` line-height  
  - "Scroll Down…" prompt → default 110%  
  - About paragraph → `12.1px` (110% of 11px)

- **Letter-spacing:** `normal` everywhere.

- **Case:** `text-transform: uppercase` on every label, heading, link in the chrome. Only the descriptive paragraph is sentence-case.

- **`antialiased`** is set on `<body>` (Tailwind = `-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale`).

### 2.3 Layout grid (the heart of the design)

The site uses a **fluid 12-column grid expressed in `vw`** with three breakpoints. Build it as utilities (matches the original Tailwind plugin):

| Utility | < 768px (mobile) | ≥ 768px (tablet) | ≥ 1024px (desktop) |
|---|---|---|---|
| `.padding-1` (1 unit padding) | `2.13333vw` | `1.04167vw` | `0.555556vw` |
| `.margin-x-1` | `0 2.13333vw` | `0 1.04167vw` | `0 0.555556vw` |
| `.gutter-gap-1` (gap between cols) | `2.13333vw` | `1.04167vw` | `0.555556vw` |
| `.span-w-1` (1-col width) | `14.1778vw` | `7.20486vw` | `7.73148vw` |
| `.span-w-2` | `30.4889vw` | `15.4514vw` | `16.0185vw` |
| `.span-w-3` | `46.8vw` | `23.6979vw` | `24.3056vw` |
| `.span-w-4` | `63.1111vw` | `31.9444vw` | `32.5926vw` |
| `.span-w-5` | `79.4222vw` | `40.191vw` | `40.8796vw` |
| `.span-w-7` | `95.7333vw` | `56.684vw` | `57.4537vw` |
| `.span-w-8` | `95.7333vw` | `64.9306vw` | `65.7407vw` |
| `.span-w-12` | `95.7333vw` | `97.9167vw` | `98.8889vw` |
| `.span-ml-1` | `14.1778vw` | `7.20486vw` | `7.73148vw` |
| `.span-ml-2` | `32.6222vw` | `16.4931vw` | `16.5741vw` |
| `.span-ml-2-wide` | `34.7556vw` | `17.5347vw` | `17.1296vw` |
| `.span-ml-3` | `48.9333vw` | `24.7396vw` | `24.8611vw` |
| `.span-mr-1-wide` | `14.1778vw` | `7.20486vw` | `7.73148vw` |
| `.span-w-screen` | `width: 100vw; margin: 0 -2.13333vw;` | `margin: 0 -1.04167vw;` | (same logic, `-0.555556vw`) |

**Mental model:** on desktop, 1 column ≈ 7.73 vw, gutter ≈ 0.56 vw, page padding ≈ 0.56 vw. The `vw` math means **everything zooms with viewport width** — there are no fixed pixel breakpoints between 1024 px and any larger size.

### 2.4 Spacing scale (vertical)

- Page padding inside the white card: `padding: 10vh 0` (`py-[10vh]`).
- Big section vertical rhythm between gallery items: `margin: 186px 0` (computed) via `.span-my-2` (used on the side-by-side double image only).
- Default vertical gap inside the gallery list: `gutter-gap-1` ≈ `6.24px` on desktop (essentially flush — items stack with a hair-line gap).
- Header info row gap (Folio Template / Roles columns) inside their own column: `gap-4` (16 px).

---

## 3. Page Skeleton

```html
<html class="overscroll-none lenis">
  <body class="antialiased margin-x-1 bg-black">  ← thin black frame
    <header class="fixed top-0 left-0 w-screen z-[52] padding-1"> … </header>

    <section class="span-w-screen bg-white">                        ← white card
      <div class="span-w-7 span-ml-2-wide py-[10vh]
                  max-md:ml-0 max-md:w-full max-md:padding-x-1
                  max-md:py-[10vh]">
          ┌── 1. Header info row (title + about + roles)
          ├── 2. Lightbox overlay (fixed, hidden by default)
          ├── 3. "Watch" hover label (fixed, mix-blend-difference)
          ├── 4. Gallery (flex column of 10 media items)
          └── 5. Right-side fixed thumbnail navigator
      </div>
    </section>

    <footer class="fixed bottom-0 left-0 w-screen flex padding-1 z-50
                   items-center justify-between"> … </footer>
  </body>
</html>
```

---

## 4. Header (fixed top bar)

```html
<header class="fixed top-0 left-0 w-screen z-[52] padding-1">
  <div class="w-full flex justify-between items-center
              text-[11px] font-medium uppercase text-black">

    <a href="/"><h1 class="span-w-2 text-black">Cathy Dolle</h1></a>

    <nav>
      <ul class="flex gutter-gap-1 md:span-w-4">
        <li class="cursor-pointer span-w-1 text-start max-md:hidden">about</li>

        <a href="/shop">
          <li class="span-w-1 text-end flex gutter-gap-1 items-center">
            <img src="…/separator.svg" alt="Séparateur" width="16" height="16">
            <p>Shop</p>
          </li>
        </a>

        <li class="span-ml-1 span-w-1 text-end max-md:span-w-2 max-md:ml-0">
          <a href="/playground">Playground</a>
        </li>
      </ul>
    </nav>
  </div>
</header>
```

**Specs:**

- Position: fixed, top:0, left:0, width: 100vw, z-index: 52 (highest), padding `padding-1`.
- All text: 11 px / 500 / uppercase / #000.
- Logo Cathy Dolle is sized `.span-w-2` (~16 vw on desktop).
- Nav UL is `.md:span-w-4` (~32.6 vw), uses `gutter-gap-1` between items.
- Three nav slots, each `.span-w-1` (~7.7 vw): about, Shop (with little 16 × 16 SVG icon to its left), Playground.
- "about" is display:none on mobile (`max-md:hidden`).
- The Shop separator SVG is rendered at width:16px; height:~10.5px (intrinsic ratio 359 × 237).
- No background (transparent) — the header floats over the white card.

---

## 5. Lead block (Title / About / Roles)

```html
<div class="h-auto w-full flex gutter-gap-1 flex-wrap
            text-[11px] text-black leading-[110%]">

  <!-- Column 1 : title + description -->
  <div class="flex flex-col gap-4 span-w-4 max-md:span-w-7">
    <h3 class="font-medium uppercase">Folio Template</h3>
    <p class="opacity-60 font-normal span-w-2 max-md:span-w-4">
      We created a portfolio template for creatives such as photographers,
      3D artists, and more, allowing them to share their projects easily
      through back-office access.
    </p>
  </div>

  <!-- Column 2 : roles -->
  <div class="flex flex-col gap-4 span-w-2 max-md:span-w-3 max-md:pt-[50px]">
    <h3 class="font-medium uppercase">ROLES</h3>
    <ul>
      <li class="uppercase">Designer</li>
      <li class="uppercase">Dev</li>
    </ul>
  </div>

  <!-- Column 3 : empty spacer (used on mobile for stacking) -->
  <div class="flex flex-col gap-4 span-w-1 max-md:pt-[50px]"></div>
</div>
```

**Specs:**

- Left column is 4 cols wide; the paragraph inside is 2 cols wide (`.span-w-2`) — so the description occupies a narrow column at the left.
- Description paragraph: opacity:.6, font-weight:400, font-size:11px, line-height:12.1px (110%).
- Roles column: 2 cols wide; "ROLES" heading is medium uppercase, items are 400 uppercase.
- Inner `gap-4` between heading and content (16 px).
- The whole strip wraps with `flex-wrap` on small screens and uses `pt-[50px]` to push the columns down on mobile.

---

## 6. Gallery (the body of the case study)

**Outer wrapper:**

```html
<div class="flex flex-col gutter-gap-1 my-[8vh] text-black max-md:mt-[58px]">
   … 10 media items …
</div>
```

The case study contains **10 sequential blocks** in this exact order:

| # | Type | Tailwind classes on the wrapper |
|---|---|---|
| 1 | Image (hero 1920×1080) | `w-full h-auto overflow-hidden relative opacity-0` |
| 2 | Video (cover poster → click to open lightbox) | `w-full h-auto aspect-panorama overflow-hidden relative bg-gray-400 opacity-0 cursor-pointer` |
| 3 | Image | same as #1 |
| 4 | Video (panorama, click to play) | same as #2 |
| 5 | Image | #1 |
| 6 | Double image side-by-side | `w-full flex gutter-gap-1 span-my-2 overflow-hidden justify-end` |
| 7 | Image | #1 |
| 8 | Image | #1 |
| 9 | Video | #2 |
| 10 | Video | #2 |

### 6.1 Single image item

- Wrapper: full-width of the column (`.span-w-7` parent ≈ 57.4 vw, ≈ 645 px @1124vw).
- `<img>` inside: `width: 100%; height: auto; object-fit: cover; overflow: hidden;`
- Default state: `opacity:0`. When the wrapper enters the viewport it animates to `opacity:1` with `transition: all` (default ~150 ms ease). It's a simple fade-in on scroll, no translate.
- All hero/section images are 16:9 (1440 × 810 source, retina 1920 × 1080).

### 6.2 Video item ("aspect-panorama")

- Defined to have aspect ratio ≈ 16 : 8.7 (≈ 1.84:1 — wider than 16:9). Use `aspect-ratio: 16 / 8.7;` (or 16 / 9 if you want to simplify, but the original is panoramic).
- `bg-gray-400` (#9CA3AF) is the placeholder color while the cover image / video loads.
- Cover image is rendered inside a wrapper at `scale(60%)`:

```html
<div class="w-full h-full scale-[60%] flex flex-col gutter-gap-1 relative">
    <img alt="video cover" class="w-full aspect-video object-cover transition-opacity duration-300">
</div>
```

Effect: the static "cover" still image preview is shown at 60% size (creating breathing room around the poster). On click the lightbox opens with the real video.

- Video element on the page (auto-loaded but muted preview): `autoplay, loop, muted, playsInline`.

### 6.3 Double image block

- Wrapper: `w-full flex gutter-gap-1 span-my-2 overflow-hidden justify-end`.
  → Two images flush right, with `gutter-gap-1` between them and 186px of vertical margin top & bottom (`.span-my-2`).
- Each image: `class="span-w-3 aspect-[11/16] object-cover"`
  → Each is 3 cols wide and a portrait 11:16 ratio.

### 6.4 Universal "fade-in on scroll"

- `opacity-0` → `opacity-1` is toggled with an IntersectionObserver.
- Transition: `transition: all` (≈ 150 ms cubic-bezier(0.4,0,0.2,1)).
- No vertical translate, no scale — only opacity.

---

## 7. Right-side fixed Thumbnail Navigator

```html
<div class="fixed span-w-1 right-0 top-1/2 -translate-y-1/2
            margin-x-1 span-mr-1-wide
            flex flex-col justify-center gutter-gap-1 items-center
            max-md:hidden">

  <div class="w-full h-full scale-[60%] flex flex-col gutter-gap-1 relative">
    <!-- Active marker overlay -->
    <div class="absolute top-0 left-0 w-full aspect-[16/19]
                border border-solid border-black scale-[110%]
                pointer-events-none z-50"></div>

    <!-- one thumb per gallery item -->
    <img class="w-full aspect-video object-cover
                hover:opacity-50 cursor-pointer
                transition-all duration-300 ease-inOut">
    … 10 more …

    <!-- For the double-image block, two mini images side-by-side -->
    <div class="w-full flex aspect-video justify-between overflow-hidden
                hover:opacity-50 cursor-pointer
                transition-all duration-300 ease-inOut">
        <img …> <img …>
    </div>
  </div>
</div>
```

**Specs:**

- Position: fixed, vertically centered (`top:50%; translate-y:-50%`), pinned to the right edge with `margin-x-1` and an extra `span-mr-1-wide` (≈ 7.7 vw). On desktop the navigator sits roughly one column from the right edge.
- Width: `.span-w-1` (~7.7 vw, ≈ 87 px).
- Inside: a `scale(60%)` wrapper that shrinks the thumbs.
- Each thumb: `aspect-video` (16:9), `object-fit:cover`. Hover: `opacity:.5`. Transition `all 300ms cubic-bezier(0.4, 0, 0.2, 1)`.
- An active item indicator is an absolutely-positioned div with a 1 px solid black border and `scale(110%)` that overlays the currently in-view thumb. It moves between items as you scroll. (It's `aspect-[16/19]` — slightly taller than the thumb so the border pads the image visually.)
- Hidden on mobile (`max-md:hidden`).
- Clicking any thumb scrolls the corresponding gallery item into view (Lenis smooth scroll).

---

## 8. Lightbox / Fullscreen video player

DOM lives in the gallery wrapper, hidden by default:

```html
<div class="fixed top-0 left-0 w-screen h-screen
            bg-white/90 z-[51] padding-1
            pointer-events-none opacity-0 flex">

  <div class="w-fit h-fit flex items-center justify-center relative m-auto">

    <video class="max-h-[80vh] relative h-fit object-cover
                  cursor-pointer span-w-8"
           src="…folio-template/v1-folio.mp4"
           loop playsInline></video>

    <!-- Floating control panel, centered over the video -->
    <div class="absolute top-1/2 left-1/2 -translate-y-1/2 -translate-x-1/2
                h-auto transition-opacity duration-300 pointer-events-none
                span-w-8 opacity-0">
      <div class="bg-black/50 p-6 h-full flex flex-col justify-center
                  gutter-gap-1 text-[11px] pointer-events-none">

        <!-- Time row -->
        <div class="flex justify-between font-medium leading-3 uppercase
                    text-white mix-blend-difference">
          <span>0:00</span><span>0:06</span>
        </div>

        <!-- Play/Mute row -->
        <div class="flex items-center justify-between">
          <button class="font-medium leading-3 uppercase text-white
                         mix-blend-difference"><p>play</p></button>
          <div class="flex items-center gap-3">
            <button class="font-medium leading-3 uppercase text-white
                           mix-blend-difference"><p>mute</p></button>
          </div>
        </div>
      </div>

      <!-- Progress bar (16 px high, full width minus padding) -->
      <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2
                  h-4 w-full">
         <!-- inner filled bar grows with currentTime/duration -->
      </div>
    </div>
  </div>
</div>
```

**Behavior:**

- Default: `opacity:0; pointer-events:none`. Click on a video item → set both to 1 and auto. Click anywhere again or the Exit label → close.
- Background: white at 90% opacity (frosted look over the page).
- Video: `max-height: 80vh`, width = `.span-w-8` (~65 vw on desktop, ~739 px @ 1124 vw).
- Control panel: 8 cols wide, centered both axes. Inner panel: `bg-black/50`, padding 24 px, `gap-1`, text 11px / 500 / uppercase / white with `mix-blend-mode: difference` so it stays legible over any frame.
- Two text rows (time-codes & play/mute), and a 16-px progress bar centered in the same wrapper.
- The literal label "Exit" is rendered (per accessibility tree) and triggers closing.

---

## 9. "Watch" hover indicator

```html
<p class="fixed translate-x-4 -translate-y-1/2
          text-[10px] text-white mix-blend-difference
          text-nowrap uppercase z-[400] pointer-events-none
          max-md:hidden">
  Watch
</p>
```

- Always rendered, follows cursor when hovering a video tile (the JS updates its `top:` and `left:` to mouse coords).
- Style: 10 px white uppercase, `mix-blend-mode: difference`, z-index: 400, never blocks pointer events.
- Hidden on mobile.

---

## 10. Bottom Scroll Prompts

These are anchored at the end of the gallery — not fixed; they scroll naturally:

```html
<!-- Top prompt (only meaningful when there's a previous project) -->
<div class="z-50 max-md:ml-0 flex items-start gutter-gap-1">
  <p class="text-nowrap uppercase font-medium text-[11px] text-black w-fit">
    Scroll Up to Previous Project
  </p>
</div>

<!-- Bottom prompt -->
<div class="span-ml-2 span-w-7 z-50 items-center max-md:ml-0
            flex gutter-gap-1">
  <p class="text-nowrap uppercase font-medium text-[11px] text-black span-w-1">
    Scroll Down to Next Project
  </p>
  <div class="pointer-events-none h-[2px] span-ml-1 span-w-5 z-50 bg-black/20"></div>
</div>
```

**Specs:**

- Both labels: 11 px / 500 / uppercase / black.
- The bottom prompt has a 2px tall horizontal rule (`bg-black/20`) that starts one column to the right and is 5 cols wide — visually tying the prompt to a thin track that points toward the next project trigger.
- The "Scroll Up" prompt sits above the lead-block area (visible only when scrolled into the previous-project transition).

---

## 11. Footer (fixed bottom bar)

```html
<footer class="fixed bottom-0 left-0 w-screen flex padding-1
               z-50 items-center justify-between">
  <p class="text-[11px] leading-[13px] font-medium text-black">
    23 %    <!-- live scroll-progress percentage -->
  </p>
  <a href="mailto:cathy.dolle@live.fr"
     class="text-black text-[11px] leading-[11px] font-medium
            hover:underline uppercase">
    Contact
  </a>
</footer>
```

**Specs:**

- Position fixed `bottom:0`, full-width, `padding-1`, z-index 50.
- Left: XX % — a JS counter showing scroll progress through the page (0–100). Updated every scroll tick (Lenis exposes scroll/progress).
- Right: "Contact" mail-to link, `hover` → underline.
- Both items: 11 px, font-weight 500, color #000, uppercase.

---

## 12. Animations & Interactions

| Behavior | Implementation |
|---|---|
| Smooth scrolling | Lenis added to `<html>` (class `lenis`, `overscroll-none`). |
| Image fade-in on enter | Wrapper starts `opacity-0`, IntersectionObserver toggles to `opacity-1` with `transition: all` (~150 ms cubic-bezier(0.4,0,0.2,1)). |
| Sidebar thumb hover | `transition-opacity 300ms ease`, `hover` → `opacity:.5` (or .8 for some thumbs). |
| Active sidebar marker | Absolutely-positioned 1 px black border scaled 110%. Its top moves between thumb positions as the corresponding gallery item enters the viewport. Use a `transform: translateY(...)` transition (~300 ms ease-in-out). |
| "Watch" cursor label | On `mousemove` over any video tile, set `style.left = e.clientX + "px"` and `top = e.clientY + "px"` (offset by `translate-x-4` and `-translate-y-1/2` so it hovers right of the cursor). Show only while hovering a video. |
| Lightbox open/close | Toggle the overlay's `opacity-0/100` and `pointer-events-none/auto`. CSS `transition: opacity .3s cubic-bezier(0.4,0,0.2,1)`. |
| Lightbox controls visibility | The control overlay starts `opacity-0`; show on cursor movement / `mouseenter` (`opacity-100`), then hide after a few seconds idle (`opacity-0` again) — same 300 ms transition. |
| Footer % counter | Updated every scroll tick: `Math.round((scrollY / (scrollHeight - innerHeight)) * 100)`. |
| Roving project transitions | "Scroll Up to Previous Project" / "Scroll Down to Next Project" — when those prompts cross the viewport edge with momentum, the router pushes to the prev/next case study (Next.js `view-transition` is enabled via `react.view_transition`). |

**Tech stack:** No GSAP, no Framer Motion, no canvas. Just CSS transitions + Lenis + IntersectionObserver.

---

## 13. Responsiveness

**Two breakpoints matter** (Tailwind defaults):
- `md` = 768 px
- `lg` = 1024 px

### Mobile (< 768 px) overrides used on this page (all are `max-md:` variants):

- **`<header>`** — about link is hidden (`max-md:hidden`).

- **Lead block columns:**
  - Title column: width changes from `.span-w-4` → `.span-w-7`.
  - Description paragraph: `.span-w-2` → `.span-w-4`.
  - Roles column: `.span-w-2` → `.span-w-3`, with extra top padding `pt-[50px]`.
  - Empty third column: extra `pt-[50px]`.

- **Inner content wrapper:** drops the left margin (`max-md:ml-0`), becomes `max-md:w-full`, gets `max-md:padding-x-1`, keeps `py-[10vh]`.

- **Gallery:** top margin becomes `mt-[58px]` (instead of `my-[8vh]`).

- **Right-side thumbnail navigator:** `max-md:hidden` (entirely removed on phones).

- **"Watch" cursor label:** `max-md:hidden`.

- **The double-image vertical margin** `.span-my-2` collapses to `my-0` on mobile.

- **Header navigation:** "Playground" widens to `.span-w-2` and removes its `ml-1` (`max-md:span-w-2 max-md:ml-0`).

**Above 768 px** the design just scales fluidly with `vw` units — there is no pixel break or reflow when going from 1024 to 1920+. Just keep using the percentages above.

---

## 14. Accessibility / SEO

- `<html lang="en">` and `suppressHydrationWarning`.
- `<header>` element with `role="banner"` (implicit). Logo wrapped in `<a aria-label="Retour à l'accueil" href="/">`.
- `<nav aria-label="Navigation principale">` with a `<ul>` of nav items.
- Shop / Playground links: `<a aria-label="Accéder à Shop">`, `<a aria-label="Accéder au playground">`.
- All gallery `<img>` use meaningful alt (e.g. "Project Image", "Double Image One", "video cover").
- The case study container is a `<section>` with the white background; semantic `<h3>` is used for "Folio Template" and "ROLES".
- `<footer>` element holds the scroll-percentage and contact link.
- Page metadata (`<title>`, OG tags, twitter card, favicon) is set via Next.js metadata export.
