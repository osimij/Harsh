# Cathy Dolle — Smooth Scroll & Project Transition Spec

**Source reference:** https://www.cathydolle.com/case-study/elie-leber

**Stack detected:** Next.js (App Router) + Lenis (smooth scroll) + GSAP (entrance/parallax tweens, but NOT used for the project-transition logic itself).

**Page layout:** The page is wrapped in a 1-unit white inset (margin-x-1, body has bg-black, the case-study `<section>` has bg-white), giving the white-card-on-black look.

---

## 1. Smooth Scrolling Engine

The page uses [Lenis](https://github.com/darkroomengineering/lenis). Confirmed by:

- `<html>` has classes `overscroll-none` `lenis` and gains `lenis-scrolling` while the user is actively scrolling.
- `window.lenisVersion` is defined.
- `document.body` has inline styles `cursor: default; overflow: hidden;` (Lenis pattern: it disables native scrolling on body and translates a child instead — except here Lenis is in "wrapper = window" mode where overflow hidden is applied selectively; the page still uses native scroll position but Lenis intercepts wheel/trackpad input and applies eased delta).

### Recommended Lenis configuration

```javascript
import Lenis from 'lenis';

const lenis = new Lenis({
  duration: 1.2,                    // feels close to the site
  easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)), // exponential ease-out
  smoothWheel: true,
  wheelMultiplier: 1,
  touchMultiplier: 1.2,
  lerp: 0.1,                        // alternative to duration; pick one
  orientation: 'vertical',
  gestureOrientation: 'vertical',
  infinite: false,
  syncTouch: false,
});

function raf(time) {
  lenis.raf(time);
  requestAnimationFrame(raf);
}
requestAnimationFrame(raf);
```

If you mix Lenis with GSAP ScrollTrigger (recommended for parallax), wire them together:

```javascript
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
gsap.registerPlugin(ScrollTrigger);

lenis.on('scroll', ScrollTrigger.update);
gsap.ticker.add((time) => lenis.raf(time * 1000));
gsap.ticker.lagSmoothing(0);
```

### CSS that supports Lenis

```css
html.lenis,
html.lenis body { height: auto; }
html.lenis-scrolling { pointer-events: none; }     /* prevents flicker */
html.lenis-scrolling iframe { pointer-events: none; }
html.lenis-stopped { overflow: hidden; }
.lenis.lenis-smooth [data-lenis-prevent] { overscroll-behavior: contain; }
```

The site also sets `overscroll-none` on `<html>` (Tailwind: `overscroll-behavior: none`). This prevents native bounce so that when the user reaches `scrollY=0` or `scrollY=max`, additional wheel input becomes "phantom delta" the page itself can read for the project-transition effect.

---

## 2. Page Structure (relevant parts)

```html
<body class="margin-x-1 bg-black" style="overflow:hidden;cursor:default;">

  <header class="fixed top-0 left-0 w-screen z-[52] padding-1">…</header>

  <!-- The actual case-study panel; sits on a white card -->
  <section class="span-w-screen bg-white">

    <!-- Project content (text blocks, media grid, captions, etc.) -->
    <div class="span-w-7 span-ml-2-wide py-[10vh]"> … project content … </div>

    <!-- TOP overlay: "Scroll Up to Previous Project" -->
    <div class="pointer-events-none fixed top-0 left-0
                text-[11px] span-w-5 span-ml-2-wide margin-1">
      <div class="z-50 flex items-start gutter-gap-1"
           style="opacity:0;">                          <!-- toggled to 1 -->
        <p class="text-nowrap uppercase font-medium text-[11px] text-black w-fit"
           style="transform: translate(0px, 50%);
                  filter: blur(2px);
                  background-image: linear-gradient(
                      to right,
                      rgb(0,0,0)   0%,
                      rgb(0,0,0)   0%,        /* <- progress stop A */
                      rgb(130,130,130) 0%,    /* <- progress stop B */
                      rgb(130,130,130) 100%);
                  background-clip: text;
                  -webkit-text-fill-color: transparent;">
          Scroll Up to Previous Project
        </p>
      </div>
    </div>

    <!-- BOTTOM overlay: "Scroll Down to Next Project" -->
    <div class="pointer-events-none flex items-center fixed
                left-0 right-0 m-auto bottom-0 z-50 h-[18vh] span-w-12">
      <div class="span-ml-2 span-w-7 z-50 flex gutter-gap-1 items-center"
           style="opacity:1;">
        <p class="text-nowrap uppercase font-medium text-[11px] text-black span-w-1"
           style="transform: translate(0px, 0%);
                  filter: blur(0px);">
          Scroll Down to Next Project
        </p>

        <!-- Track + fill -->
        <div class="pointer-events-none h-[2px] span-ml-1 span-w-5 z-50 bg-black/20">
          <div class="w-0 h-full bg-black origin-right" style="width:0%;"></div>
        </div>
      </div>
    </div>

  </section>

  <footer class="fixed bottom-0 left-0 w-screen flex padding-1 z-50
                 items-center justify-between">
    <p class="text-[11px] font-medium text-black">0 %</p>   <!-- scroll progress -->
    <a>Contact</a>
  </footer>
</body>
```

### Key things to note:

- The two trigger elements are `position: fixed` so they stay on screen at the page edges.
- The "previous project" indicator pins to the top; the "next project" indicator pins to the bottom.
- The progress visual is two completely different mechanics:
  - **Bottom (down → next):** a real DOM bar — a child `<div>` whose width goes from 0% to 100%.
  - **Top (up → previous):** the text itself is filled left-to-right via a 4-stop CSS linear-gradient that is clipped to the text glyphs (`background-clip: text; -webkit-text-fill-color: transparent`). Stops 2 and 3 share the same percentage, which is the "fill cursor".

---

## 3. The Two Project-Transition Effects — Behaviour Spec

Both effects share the same controller: an "overscroll accumulator" that listens to wheel/touch delta beyond the natural scroll bounds, advances a 0→1 progress value, and fires a navigation when progress reaches 1.

### 3.1 Shared mechanics (from instrumentation)

Dispatched controlled wheel events and read the styles back. Measured constants:

| Observation | Value |
|---|---|
| Wheel delta per 1% of progress | 17.5 px (1px wheelDelta = 0.0571% progress) |
| Total overscroll required to navigate | 1750 px of accumulated delta |
| Direction reversal (1 wheel tick the other way) | resets accumulator to 0 immediately |
| Idle behaviour (no input for 5 s+) | accumulator persists, does NOT decay |
| Active state | wrap.opacity = 1, p.transform = translate(0,0%), p.filter = blur(0) |
| Inactive state (top trigger only) | wrap.opacity = 0, p.transform = translate(0,50%), p.filter = blur(2px) |
| Inline transitions on these elements | transition: all (≈ Tailwind transition-all); duration not explicitly set in inline style — site uses ~300–500 ms feel; recommend 400 ms ease-out |

### 3.2 "Scroll Down to Next Project"

**Trigger conditions:**

- `window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1` (user is at the bottom of the page; Lenis already eased them there).
- The user produces additional downward wheel/touch delta (`deltaY > 0`).

**While the conditions hold:**

- Accumulate `progress += deltaY / 1750` (clamped to [0, 1]).
- Set the inner fill bar's inline width: `fill.style.width = (progress * 100) + '%'`.
- The "Scroll Down to Next Project" text + bar are already visible on this page (they live at the bottom of the white card and become the last thing the user sees).

**Reset conditions:**

- Any negative `deltaY` (user wheels back up) → `progress = 0` (instant reset).
- User scrolls away from the bottom (e.g. via anchor / keyboard) → `progress = 0`.

**Trigger:**

- When `progress >= 1` → call `router.push('/case-study/<next-slug>')` (Next.js client-side nav). After navigation the new page mounts with `scrollY = 0` (Lenis is reset on route change — see §6).

### 3.3 "Scroll Up to Previous Project"

**Trigger conditions:**

- `window.scrollY <= 0` (user is at the top, again Lenis-eased).
- The user produces upward wheel/touch delta (`deltaY < 0`).

**Reveal animation (driven by progress, not by an extra timeline):**

- Wrapper opacity: `0 → 1`.
- `<p>` transform: `translate(0, 50%) → translate(0, 0%)` (slides up into place).
- `<p>` filter: `blur(2px) → blur(0px)` (focuses in).
- These three properties are eased via `CSS transition: all` (use 400 ms ease-out). Drive them by the same progress 0→1 — for example, snap them to the active state once `progress > 0` and snap back to inactive at `progress === 0`. (The site does this — the visual is binary "active vs idle"; it is the fill that moves continuously.)

**Fill animation (continuous, driven by progress):**

- The text uses a 4-stop linear-gradient as above. Update only the two middle stops to the same value P%:

```javascript
p.style.backgroundImage =
    `linear-gradient(to right,
      rgb(0,0,0) 0%,
      rgb(0,0,0) ${P}%,
      rgb(130,130,130) ${P}%,
      rgb(130,130,130) 100%)`;
```

This produces a hard "wipe" where black (the active fill) overtakes grey (the unread text) from left to right.

**Reset / trigger / persistence:** identical to the down-direction (instant reset on reversed wheel, persistent on idle, fires navigation at progress 1).

### 3.4 Why this feels nice

- The user never has to click — the gesture itself is the affordance.
- The visual feedback is proportional and bidirectional (one tick back undoes it), so it forgives accidental scrolls.
- Because Lenis intercepts the wheel and `overscroll-behavior: none` is set, the browser never bounces or shows the rubber-band effect — every "extra" deltaY is yours to consume.

---

## 4. Reference Implementation (framework-agnostic)

```javascript
// projectTransition.js
// Hooks up two overlays and triggers prev/next navigation on overscroll.
// Drop-in: pass the slugs and a navigate() callback (router.push, etc.).

export function initProjectTransition({ prevHref, nextHref, navigate }) {
  const TRIGGER_PX = 1750; // accumulated delta required

  const prevWrap = document.querySelector('[data-prev-wrap]');
  const prevText = document.querySelector('[data-prev-text]');
  const nextFill = document.querySelector('[data-next-fill]');

  let progress = 0;          // 0..1 in the *currently active* direction
  let direction = 0;         // -1 = up/prev, +1 = down/next, 0 = idle
  let navigating = false;

  function atTop()    { return window.scrollY <= 0; }
  function atBottom() {
    return window.innerHeight + window.scrollY
        >= document.documentElement.scrollHeight - 1;
  }

  function setPrevVisual(p) {
    prevWrap.style.opacity = p > 0 ? '1' : '0';
    prevText.style.transform = p > 0 ? 'translate(0, 0%)' : 'translate(0, 50%)';
    prevText.style.filter = p > 0 ? 'blur(0px)' : 'blur(2px)';
    const pct = (p * 100).toFixed(4);
    prevText.style.backgroundImage = `linear-gradient(to right,
      rgb(0,0,0) 0%, rgb(0,0,0) ${pct}%,
      rgb(130,130,130) ${pct}%, rgb(130,130,130) 100%)`;
  }
  function setNextVisual(p) {
    nextFill.style.width = (p * 100).toFixed(4) + '%';
  }

  function reset() {
    progress = 0; direction = 0;
    setPrevVisual(0); setNextVisual(0);
  }

  function tryFire() {
    if (progress < 1 || navigating) return;
    navigating = true;
    if (direction < 0 && prevHref) navigate(prevHref);
    if (direction > 0 && nextHref) navigate(nextHref);
  }

  function onWheel(e) {
    if (navigating) return;
    const dy = e.deltaY;

    // Direction reversal → instant reset
    if (direction !== 0 && Math.sign(dy) !== direction) {
      reset();
      return;
    }

    if (atBottom() && dy > 0) {
      direction = 1;
      progress = Math.min(1, progress + dy / TRIGGER_PX);
      setNextVisual(progress);
      tryFire();
    } else if (atTop() && dy < 0) {
      direction = -1;
      progress = Math.min(1, progress + (-dy) / TRIGGER_PX);
      setPrevVisual(progress);
      tryFire();
    } else {
      // Not at a boundary → ignore (Lenis handles the smooth scroll)
    }
  }

  // Touch equivalent: convert touchmove into deltaY by tracking last Y
  let lastTouchY = null;
  function onTouchStart(e) { lastTouchY = e.touches[0].clientY; }
  function onTouchMove(e) {
    const y = e.touches[0].clientY;
    if (lastTouchY !== null) {
      const dy = lastTouchY - y; // invert: drag up = scroll down
      onWheel({ deltaY: dy });
    }
    lastTouchY = y;
  }
  function onTouchEnd() { lastTouchY = null; }

  window.addEventListener('wheel', onWheel, { passive: true });
  window.addEventListener('touchstart', onTouchStart, { passive: true });
  window.addEventListener('touchmove', onTouchMove,  { passive: true });
  window.addEventListener('touchend', onTouchEnd);

  // Reset when scrolling away from a boundary
  window.addEventListener('scroll', () => {
    if (!atTop() && !atBottom()) reset();
  }, { passive: true });

  return () => {
    window.removeEventListener('wheel', onWheel);
    window.removeEventListener('touchstart', onTouchStart);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onTouchEnd);
  };
}
```

### CSS to back it up:

```css
[data-prev-text],
[data-next-fill] {
  transition: transform 400ms cubic-bezier(0.22,1,0.36,1),
              filter   400ms cubic-bezier(0.22,1,0.36,1),
              opacity  400ms cubic-bezier(0.22,1,0.36,1),
              width    120ms linear,
              background-image 80ms linear;
  will-change: transform, filter, opacity, width, background-image;
}
[data-prev-wrap]  { transition: opacity 400ms cubic-bezier(0.22,1,0.36,1); }
[data-prev-text]  { background-clip: text; -webkit-text-fill-color: transparent; }
```

### HTML scaffolding (matching the site's classes can be replaced by your own):

```html
<!-- Top overlay -->
<div data-prev-wrap class="prev-wrap" style="opacity:0;">
  <p data-prev-text class="prev-text"
     style="transform:translate(0,50%);filter:blur(2px);
            background-image:linear-gradient(to right,
              rgb(0,0,0) 0%, rgb(0,0,0) 0%,
              rgb(130,130,130) 0%, rgb(130,130,130) 100%);">
    Scroll Up to Previous Project
  </p>
</div>

<!-- Bottom overlay -->
<div class="next-wrap">
  <p class="next-text">Scroll Down to Next Project</p>
  <div class="next-track">
    <div data-next-fill class="next-fill" style="width:0%;"></div>
  </div>
</div>
```

---

## 5. Other Animation Details Worth Replicating

Inspecting media tiles inside the case study, every image/video block has inline GSAP-set styles like:

```
translate: none; rotate: none; scale: none;
transform: translate(0px, 0px);
opacity: 1;
```

That signature is GSAP's standard output. The site uses GSAP + ScrollTrigger to:

- Reveal blocks as they enter the viewport (opacity 0 → 1, sometimes a small translateY rise of a few px). Trigger ~when the element's top is 80% down the viewport.
- Update the bottom-left scroll percentage ("0 %", "20 %", "100 %" in `<footer>`). Bind `scrollY / (scrollHeight - innerHeight) * 100` and round.
- Fade the right-side thumbnail strip's active state as you scroll past matching media (out of scope for this transition, but you'll see the small image grid on the right highlighting the currently-viewed group).

### Recommended ScrollTrigger snippet for the simple reveal:

```javascript
gsap.utils.toArray('[data-reveal]').forEach(el => {
  gsap.fromTo(el,
    { autoAlpha: 0, y: 20 },
    {
      autoAlpha: 1, y: 0, duration: 0.8, ease: 'power3.out',
      scrollTrigger: { trigger: el, start: 'top 85%', once: true }
    });
});
```

---

## 6. Next.js (App Router) integration notes

- Project pages live at `/case-study/<slug>`. Navigation is client-side (`router.push`) so the page swap is instant.
- After the route changes, reset Lenis & ScrollTrigger so the new page starts at top:

```javascript
// In the case-study layout
useEffect(() => {
  lenis?.scrollTo(0, { immediate: true });
  ScrollTrigger.refresh();
}, [pathname]);
```

- The previous/next slug for each case study is data — keep it next to the project content (CMS field or a simple ordered array). The transition controller only needs the two URLs.
- Because the controller resets on direction reversal, the user can always "abort" mid-transition without surprising teleports.

---

## 7. Acceptance Checklist (what your dev can verify)

- Lenis is initialized once at the app root; pages have `transition: all` overlays correctly hooked up.
- At the top of any project, wheeling up:
  - The "Scroll Up to Previous Project" line fades in, slides up from `translateY(50%)` and de-blurs.
  - The text fills left → right with black, in proportion to accumulated wheel delta.
  - Reaching 100% (≈ 1750 px) navigates to the previous project.
  - One downward tick at any progress < 100% snaps the bar back to 0, hides the indicator and re-blurs the text.

- At the bottom of any project, wheeling down:
  - The 2px black bar fills left → right.
  - Reaching 100% navigates to the next project.
  - One upward tick resets the fill to 0%.

- Idle for 5 s mid-progress does NOT advance or decay. Progress resumes from the same value when the user wheels again in the same direction.
- Browser bounce / rubber-band is suppressed (`overscroll-behavior: none` on html).
- Bottom-left "% scrolled" updates in real time and reads 0 % at top, 100 % at bottom.

---

**That's everything needed to rebuild the smooth-scroll feel and the two project-to-project overscroll transitions.** The only "magic numbers" worth tuning to taste are: the 1750 px trigger threshold, the 400 ms transition for blur/translate/opacity, and Lenis' duration / lerp values.
