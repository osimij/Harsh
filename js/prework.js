/* =============================================================
   Prework - interactions
   - IntersectionObserver fade-in for gallery items
   - Active thumbnail marker tracking
   - "Watch" cursor label on video hover
   - Lightbox open/close with auto-hiding controls
   - Footer scroll-progress percentage
   ============================================================= */

(function () {
    'use strict';

    const galleryItems = Array.from(document.querySelectorAll('.g-item'));
    const thumbs = Array.from(document.querySelectorAll('.thumb'));
    const thumbMarker = document.getElementById('thumb-marker');
    const watchCursor = document.getElementById('watch-cursor');
    const lightbox = document.getElementById('lightbox');
    const lightboxControls = document.getElementById('lightbox-controls');
    const lightboxImage = document.getElementById('lightbox-image');
    const lbExit = document.getElementById('lb-exit');
    const lbPlay = document.getElementById('lb-play');
    const lbMute = document.getElementById('lb-mute');
    const lbProgress = document.getElementById('lb-progress');
    const lbTimeCurrent = document.getElementById('lb-time-current');
    const lightboxIndex = document.getElementById('lightbox-index');
    const scrollPct = document.getElementById('scroll-pct');

    /* ---------- 1. Fade-in on scroll ---------- */
    const fadeObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-visible');
                fadeObserver.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1, rootMargin: '0px 0px -10% 0px' });

    galleryItems.forEach((item) => {
        item.classList.add('will-fade');
        const rect = item.getBoundingClientRect();
        if (rect.top < window.innerHeight * 0.92 && rect.bottom > 0) {
            item.classList.add('is-visible');
        }
        fadeObserver.observe(item);
    });

    /* ---------- 2. Active thumbnail marker ---------- */
    const THUMB_SCROLL_DURATION = 2000;
    const THUMB_SCROLL_EASE = 'cubic-bezier(0.65, 0, 0.35, 1)';
    let activeKey = 0;
    let lockedActiveKey = null;
    let smoothScrollFrame = null;

    function moveMarkerTo(key) {
        if (!thumbMarker) return;
        const targetThumb = thumbs.find((t) => t.dataset.thumb === String(key));
        if (!targetThumb) return;

        // The thumbnail list is scaled with CSS. offsetTop/offsetHeight keep us
        // in the list's own coordinate system, so the marker does not drift.
        thumbMarker.style.top = `${targetThumb.offsetTop}px`;
        thumbMarker.style.height = `${targetThumb.offsetHeight}px`;
        thumbMarker.style.aspectRatio = 'auto';
    }

    function updateActiveThumb() {
        if (!galleryItems.length) return;
        if (lockedActiveKey !== null) {
            activeKey = lockedActiveKey;
            moveMarkerTo(activeKey);
            return;
        }

        let nearestItem = galleryItems[0];
        let largestVisibleArea = 0;
        let nearestDistance = Infinity;
        const viewportFocus = window.innerHeight * 0.5;

        galleryItems.forEach((item) => {
            const rect = item.getBoundingClientRect();
            const visibleTop = Math.max(rect.top, 0);
            const visibleBottom = Math.min(rect.bottom, window.innerHeight);
            const visibleArea = Math.max(visibleBottom - visibleTop, 0);

            if (visibleArea <= 0) return;

            const itemFocus = rect.top + rect.height * 0.5;
            const distance = Math.abs(itemFocus - viewportFocus);

            if (visibleArea > largestVisibleArea || (visibleArea === largestVisibleArea && distance < nearestDistance)) {
                largestVisibleArea = visibleArea;
                nearestDistance = distance;
                nearestItem = item;
            }
        });

        const key = parseInt(nearestItem.dataset.thumbKey, 10);
        if (!Number.isNaN(key) && key !== activeKey) {
            activeKey = key;
            moveMarkerTo(key);
        } else {
            moveMarkerTo(activeKey);
        }
    }

    let activeThumbFrame = null;

    function requestActiveThumbUpdate() {
        if (activeThumbFrame !== null) return;
        activeThumbFrame = window.requestAnimationFrame(() => {
            activeThumbFrame = null;
            updateActiveThumb();
        });
    }

    // Initialize marker position once everything is laid out
    window.addEventListener('load', updateActiveThumb);
    window.addEventListener('scroll', requestActiveThumbUpdate, { passive: true });
    window.addEventListener('resize', requestActiveThumbUpdate);

    function easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    function getScrollTargetForItem(item) {
        const rect = item.getBoundingClientRect();
        const absoluteTop = rect.top + window.scrollY;
        const centeredTop = absoluteTop - (window.innerHeight - rect.height) / 2;
        const maxScroll = document.documentElement.scrollHeight - window.innerHeight;

        return Math.max(0, Math.min(centeredTop, maxScroll));
    }

    function smoothScrollToItem(item, key) {
        if (smoothScrollFrame !== null) {
            window.cancelAnimationFrame(smoothScrollFrame);
            smoothScrollFrame = null;
        }

        const startY = window.scrollY;
        const targetY = getScrollTargetForItem(item);
        const distance = targetY - startY;
        const duration = THUMB_SCROLL_DURATION;
        const startTime = performance.now();

        lockedActiveKey = key;
        activeKey = key;
        if (thumbMarker) {
            thumbMarker.style.setProperty('--thumb-marker-duration', `${THUMB_SCROLL_DURATION}ms`);
            thumbMarker.style.setProperty('--thumb-marker-ease', THUMB_SCROLL_EASE);
        }
        moveMarkerTo(activeKey);

        function step(now) {
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const eased = easeInOutCubic(progress);

            window.scrollTo(0, startY + distance * eased);

            if (progress < 1) {
                smoothScrollFrame = window.requestAnimationFrame(step);
                return;
            }

            smoothScrollFrame = null;
            lockedActiveKey = null;
            updateActiveThumb();
            if (thumbMarker) {
                window.setTimeout(() => {
                    thumbMarker.style.removeProperty('--thumb-marker-duration');
                    thumbMarker.style.removeProperty('--thumb-marker-ease');
                }, 100);
            }
        }

        smoothScrollFrame = window.requestAnimationFrame(step);
    }

    // Click thumb -> scroll to gallery item
    thumbs.forEach((thumb) => {
        thumb.addEventListener('click', () => {
            const key = thumb.dataset.thumb;
            const target = galleryItems.find((g) => g.dataset.thumbKey === key);
            if (target) {
                const numericKey = parseInt(key, 10);
                if (Number.isNaN(numericKey)) return;
                smoothScrollToItem(target, numericKey);
            }
        });
    });

    /* ---------- 3. "Watch" cursor label on video hover ---------- */
    const videoItems = galleryItems.filter((item) => item.classList.contains('g-video'));

    function showWatchAt(x, y) {
        if (!watchCursor) return;
        watchCursor.style.left = `${x}px`;
        watchCursor.style.top = `${y}px`;
        watchCursor.classList.add('is-visible');
    }

    function hideWatch() {
        if (!watchCursor) return;
        watchCursor.classList.remove('is-visible');
    }

    videoItems.forEach((item) => {
        item.addEventListener('mousemove', (e) => showWatchAt(e.clientX, e.clientY));
        item.addEventListener('mouseleave', hideWatch);
    });

    /* ---------- 4. Lightbox ---------- */
    let controlsHideTimer = null;
    let progressTimer = null;
    const FAKE_DURATION = 6; // seconds, matches "0:06" label

    function openLightbox(sourceItem) {
        if (!lightbox) return;
        // Pull the cover image from the source item into the lightbox preview
        const sourceImg = sourceItem.querySelector('img');
        const sourceArt = sourceItem.querySelector('.study-frame');
        const lightboxArt = lightbox.querySelector('.study-frame');
        if (sourceImg && lightboxImage) {
            lightboxImage.src = sourceImg.getAttribute('src');
            lightboxImage.alt = sourceImg.getAttribute('alt') || 'Lightbox preview';
            // Carry over the light/dark logo treatment
            lightboxImage.classList.toggle('study-logo-light', sourceImg.classList.contains('study-logo-light'));
        }
        if (sourceArt && lightboxArt) {
            lightboxArt.classList.toggle('study-frame-dark', sourceArt.classList.contains('study-frame-dark'));
            lightboxArt.classList.toggle('study-frame-light', sourceArt.classList.contains('study-frame-light'));
        }
        if (lightboxIndex) {
            const key = String(Number(sourceItem.dataset.thumbKey || 0) + 1).padStart(2, '0');
            lightboxIndex.textContent = key;
        }

        lightbox.classList.add('is-open');
        lightbox.setAttribute('aria-hidden', 'false');
        showControls();
        startFakeProgress();
    }

    function closeLightbox() {
        if (!lightbox) return;
        lightbox.classList.remove('is-open');
        lightbox.setAttribute('aria-hidden', 'true');
        hideControls();
        stopFakeProgress();
    }

    function showControls() {
        if (!lightboxControls) return;
        lightboxControls.classList.add('is-visible');
        clearTimeout(controlsHideTimer);
        controlsHideTimer = setTimeout(hideControls, 2400);
    }

    function hideControls() {
        if (!lightboxControls) return;
        lightboxControls.classList.remove('is-visible');
    }

    function startFakeProgress() {
        stopFakeProgress();
        let elapsed = 0;
        const tick = 100; // ms
        progressTimer = setInterval(() => {
            elapsed += tick / 1000;
            if (elapsed >= FAKE_DURATION) elapsed = 0;
            const pct = (elapsed / FAKE_DURATION) * 100;
            if (lbProgress) lbProgress.style.width = `${pct}%`;
            if (lbTimeCurrent) {
                const secs = Math.floor(elapsed);
                lbTimeCurrent.textContent = `0:${String(secs).padStart(2, '0')}`;
            }
        }, tick);
    }

    function stopFakeProgress() {
        clearInterval(progressTimer);
        progressTimer = null;
    }

    videoItems.forEach((item) => {
        item.addEventListener('click', () => openLightbox(item));
    });

    if (lightbox) {
        lightbox.addEventListener('click', (e) => {
            // Click on backdrop or media closes
            if (e.target === lightbox || e.target.id === 'lightbox-media' || e.target.id === 'lightbox-image') {
                closeLightbox();
            }
        });
        lightbox.addEventListener('mousemove', showControls);
    }
    if (lbExit) lbExit.addEventListener('click', (e) => { e.stopPropagation(); closeLightbox(); });
    if (lbPlay) lbPlay.addEventListener('click', (e) => {
        e.stopPropagation();
        const p = lbPlay.querySelector('p');
        if (p) p.textContent = p.textContent.toLowerCase() === 'play' ? 'pause' : 'play';
    });
    if (lbMute) lbMute.addEventListener('click', (e) => {
        e.stopPropagation();
        const p = lbMute.querySelector('p');
        if (p) p.textContent = p.textContent.toLowerCase() === 'mute' ? 'unmute' : 'mute';
    });

    // Esc closes
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && lightbox && lightbox.classList.contains('is-open')) {
            closeLightbox();
        }
    });

    /* ---------- 5. Footer scroll % counter ---------- */
    function updateScrollPct() {
        if (!scrollPct) return;
        const max = document.documentElement.scrollHeight - window.innerHeight;
        const pct = max > 0 ? Math.round((window.scrollY / max) * 100) : 0;
        scrollPct.textContent = `${pct} %`;
    }

    window.addEventListener('scroll', updateScrollPct, { passive: true });
    window.addEventListener('resize', updateScrollPct);
    updateScrollPct();

})();
