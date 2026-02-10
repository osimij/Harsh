/**
 * Work Gallery & Case Study — query-param routed SPA
 *
 * Routes:
 *   work.html            → gallery grid
 *   work.html?project=ak → case study detail
 */
(async function () {
    'use strict';

    const MANIFEST_URL = 'assets/logos/logos.json';
    const LOGOS_DIR    = 'assets/logos/';

    // ---- Helpers ------------------------------------------------

    /** Build a gallery URL from the current page URL while preserving the current path shape. */
    function getGalleryHref() {
        const url = new URL(window.location.href);
        url.searchParams.delete('project');
        url.hash = '';
        const query = url.searchParams.toString();
        return url.pathname + (query ? `?${query}` : '');
    }

    /** Build a detail URL from the current page URL while preserving the current path shape. */
    function getProjectHref(projectId) {
        const url = new URL(window.location.href);
        url.searchParams.set('project', projectId);
        url.hash = '';
        return `${url.pathname}?${url.searchParams.toString()}`;
    }

    /** Deduplicate internal SVG IDs to prevent DOM collisions */
    function deduplicateSvgIds(svgString, prefix) {
        return svgString
            .replace(/\bid="([^"]+)"/g, `id="${prefix}_$1"`)
            .replace(/url\(#([^)]+)\)/g, `url(#${prefix}_$1)`)
            .replace(/#clip(\d)/g, `#${prefix}_clip$1`);
    }

    /** Recolor SVG shape fills to a single color (e.g. white) */
    function recolorSvg(svgString, logoColor) {
        if (!logoColor) return svgString;
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgString, 'image/svg+xml');
        const shapes = doc.querySelectorAll('path, circle, ellipse, polygon, polyline, line, rect');
        shapes.forEach(el => {
            // Skip elements inside <defs>
            if (el.closest('defs')) return;
            const fill = el.getAttribute('fill');
            if (fill && fill.toLowerCase() !== 'none') {
                el.setAttribute('fill', logoColor);
            }
        });
        return new XMLSerializer().serializeToString(doc.documentElement);
    }

    // ---- Data ---------------------------------------------------

    let manifest = [];
    let svgCache = {}; // id → raw svg string
    let activeFilter = 'all';
    let allTags = [];

    // --- Timing constants ---
    const FILTER_FADE_OUT_MS  = 180;
    const FILTER_FADE_IN_MS   = 280;
    const FILTER_EASING       = 'cubic-bezier(0.22, 1, 0.36, 1)';

    let isFilterAnimating = false;
    let queuedFilter = null;
    let filterAnimationToken = 0;
    const trackedFilterAnimations = new Set();
    const pendingFilterTimeouts = new Set();

    // ---- Sidebar indicator state --------------------------------
    let sidebarIndicator = null;

    async function loadManifest() {
        const res = await fetch(MANIFEST_URL);
        if (!res.ok) throw new Error(`Manifest load failed (${res.status})`);
        const data = await res.json();
        manifest = data.logos;
    }

    /** Fetch a single SVG and cache it */
    async function fetchSvg(logo) {
        if (svgCache[logo.id]) return svgCache[logo.id];
        const res = await fetch(LOGOS_DIR + logo.file);
        if (!res.ok) throw new Error(`Failed to load ${logo.file}`);
        const text = await res.text();
        svgCache[logo.id] = text;
        return text;
    }

    // ---- Router -------------------------------------------------

    const params    = new URLSearchParams(window.location.search);
    const projectId = params.get('project');

    const galleryView = document.getElementById('gallery-view');
    const detailView  = document.getElementById('detail-view');

    function showGallery() {
        galleryView.hidden = false;
        detailView.hidden  = true;
        document.documentElement.classList.remove('work-route-detail');
        document.body.classList.remove('work-detail-view');
        window.scrollTo(0, 0);
    }

    function showDetail() {
        galleryView.hidden = true;
        detailView.hidden  = false;
        document.documentElement.classList.add('work-route-detail');
        document.body.classList.add('work-detail-view');
        window.scrollTo(0, 0);
    }

    // ---- Gallery ------------------------------------------------

    async function renderGallery() {
        showGallery();

        // Fetch all SVGs in parallel
        const svgPromises = manifest.map(logo => fetchSvg(logo));
        const svgs = await Promise.all(svgPromises);

        const grid = galleryView.querySelector('.work-grid');

        manifest.forEach((logo, i) => {
            const cell = document.createElement('a');
            cell.className = 'work-cell';
            cell.href = getProjectHref(logo.id);
            cell.setAttribute('role', 'listitem');
            cell.setAttribute('aria-label', logo.displayName || logo.name);
            cell.setAttribute('data-tags', (logo.tags || []).join(','));

            // Deduplicate SVG IDs, then recolor if logoColor is set
            let svgStr = deduplicateSvgIds(svgs[i], `wk_${logo.id}`);
            if (logo.logoColor) {
                svgStr = recolorSvg(svgStr, logo.logoColor);
            }

            // Thumbnail with colored background
            const thumbnail = document.createElement('div');
            thumbnail.className = 'work-cell__thumbnail';
            if (logo.thumbnailBg) {
                thumbnail.style.backgroundColor = logo.thumbnailBg;
            }

            const logoWrap = document.createElement('div');
            logoWrap.className = 'work-cell__logo';
            logoWrap.innerHTML = svgStr;

            const svgEl = logoWrap.querySelector('svg');
            if (svgEl) svgEl.setAttribute('aria-hidden', 'true');

            thumbnail.appendChild(logoWrap);

            // Info block below thumbnail
            const info = document.createElement('span');
            info.className = 'work-cell__info';
            if (logo.tags && logo.tags.length > 0) {
                info.classList.add('hasSubtitle');
            }

            const titleEl = document.createElement('span');
            titleEl.className = 'work-cell__title';
            titleEl.textContent = logo.displayName || logo.name;

            info.appendChild(titleEl);

            if (logo.tags && logo.tags.length > 0) {
                const subtitleEl = document.createElement('span');
                subtitleEl.className = 'work-cell__subtitle';
                subtitleEl.textContent = logo.tags.join(', ');
                info.appendChild(subtitleEl);
            }

            cell.appendChild(thumbnail);
            cell.appendChild(info);
            grid.appendChild(cell);
        });
    }

    // ---- Detail -------------------------------------------------

    async function renderDetail(id) {
        const project = manifest.find(l => l.id === id);
        if (!project) {
            // Unknown project — redirect to gallery
            window.location.href = getGalleryHref();
            return;
        }

        showDetail();

        const detailBack = document.querySelector('.detail-back');
        if (detailBack) {
            detailBack.setAttribute('href', getGalleryHref());
        }

        // Title
        document.getElementById('detail-title').textContent =
            project.displayName || project.name;

        // Hero — use SVG if no heroImage
        const heroEl = document.getElementById('detail-hero');
        if (project.heroImage) {
            heroEl.classList.remove('detail-hero--svg');
            heroEl.innerHTML = `<img src="${project.heroImage}" alt="${project.displayName || project.name}">`;
        } else {
            heroEl.classList.add('detail-hero--svg');
            const svg = await fetchSvg(project);
            const deduped = deduplicateSvgIds(svg, `detail_${project.id}`);
            heroEl.innerHTML = deduped;
        }

        // Tags + year
        const tagsEl = document.getElementById('detail-tags');
        tagsEl.innerHTML = '';
        if (project.tags) {
            project.tags.forEach(tag => {
                const span = document.createElement('span');
                span.className = 'detail-tag';
                span.textContent = tag;
                tagsEl.appendChild(span);
            });
        }
        if (project.year) {
            const yearSpan = document.createElement('span');
            yearSpan.className = 'detail-year';
            yearSpan.textContent = project.year;
            tagsEl.appendChild(yearSpan);
        }

        // Description
        document.getElementById('detail-description').textContent =
            project.description || '';

        // External link
        const linkWrap = document.getElementById('detail-link-wrap');
        linkWrap.innerHTML = '';
        if (project.link) {
            const a = document.createElement('a');
            a.className = 'detail-link';
            a.href = project.link;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = 'View Project';
            linkWrap.appendChild(a);
        }

        // Page title
        document.title = `${project.displayName || project.name} — Harsh Bika`;
    }

    // ---- Sidebar & Filtering ------------------------------------

    function extractTags(logos) {
        const hiddenTags = new Set(['Corporate', '3D', 'Personal', 'Science', 'Tech', 'Streetwear']);
        const tagSet = new Set();
        logos.forEach(logo => {
            if (logo.tags) logo.tags.forEach(t => {
                if (!hiddenTags.has(t)) tagSet.add(t);
            });
        });
        return Array.from(tagSet);
    }

    function buildSidebar() {
        const nav = galleryView.querySelector('.sidebar-nav');
        if (!nav) return;

        // "All" button
        const allBtn = document.createElement('button');
        allBtn.className = 'sidebar-link sidebar-link--active';
        allBtn.textContent = 'All';
        allBtn.setAttribute('data-filter', 'all');
        allBtn.addEventListener('click', handleFilterClick);
        nav.appendChild(allBtn);

        // Tag buttons
        allTags.forEach(tag => {
            const btn = document.createElement('button');
            btn.className = 'sidebar-link';
            btn.textContent = tag;
            btn.setAttribute('data-filter', tag);
            btn.addEventListener('click', handleFilterClick);
            nav.appendChild(btn);
        });

        // Build sliding indicator (desktop only)
        buildSidebarIndicator(nav);
    }

    // ---- Sidebar Indicator (desktop) ----------------------------

    function buildSidebarIndicator(nav) {
        sidebarIndicator = document.createElement('div');
        sidebarIndicator.className = 'sidebar-indicator';
        nav.style.position = 'relative';
        nav.appendChild(sidebarIndicator);

        // Position on the initially active button after layout
        requestAnimationFrame(() => {
            const activeBtn = nav.querySelector('.sidebar-link--active');
            if (activeBtn) positionIndicator(activeBtn, false);
        });
    }

    function positionIndicator(targetBtn, animate) {
        if (!sidebarIndicator || !targetBtn) return;

        const nav = targetBtn.closest('.sidebar-nav');
        if (!nav) return;

        // Hide on tablet/mobile (nav is row-wrapped)
        const isDesktop = window.matchMedia('(min-width: 1101px)').matches;
        if (!isDesktop) {
            sidebarIndicator.style.opacity = '0';
            return;
        }

        const navRect = nav.getBoundingClientRect();
        const btnRect = targetBtn.getBoundingClientRect();

        const top = btnRect.top - navRect.top;
        const left = btnRect.left - navRect.left;
        const width = btnRect.width;
        const height = btnRect.height;

        const prefersReducedMotion =
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        if (!animate || prefersReducedMotion) {
            sidebarIndicator.style.transform = `translate(${left}px, ${top}px)`;
            sidebarIndicator.style.width = `${width}px`;
            sidebarIndicator.style.height = `${height}px`;
            sidebarIndicator.style.opacity = '0.04';
            return;
        }

        trackFilterAnimation(sidebarIndicator.animate(
            [
                {
                    transform: sidebarIndicator.style.transform || `translate(${left}px, ${top}px)`,
                    width: sidebarIndicator.style.width || `${width}px`,
                    height: sidebarIndicator.style.height || `${height}px`,
                    opacity: 0.04
                },
                {
                    transform: `translate(${left}px, ${top}px)`,
                    width: `${width}px`,
                    height: `${height}px`,
                    opacity: 0.04
                }
            ],
            {
                duration: 280,
                easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
                fill: 'forwards'
            }
        ));

        // Commit final values
        sidebarIndicator.style.transform = `translate(${left}px, ${top}px)`;
        sidebarIndicator.style.width = `${width}px`;
        sidebarIndicator.style.height = `${height}px`;
        sidebarIndicator.style.opacity = '0.04';
    }

    function updateSidebarActiveState(filter) {
        const links = galleryView.querySelectorAll('.sidebar-link');
        let targetBtn = null;
        links.forEach(link => {
            const isActive = link.getAttribute('data-filter') === filter;
            link.classList.toggle('sidebar-link--active', isActive);
            if (isActive) targetBtn = link;
        });

        // Slide indicator to the new active button
        if (targetBtn) positionIndicator(targetBtn, true);
    }

    async function requestFilter(filter) {
        if (filter === activeFilter && !isFilterAnimating) return;

        queuedFilter = filter;
        updateSidebarActiveState(filter);

        if (isFilterAnimating) return;
        isFilterAnimating = true;

        while (queuedFilter !== null) {
            const nextFilter = queuedFilter;
            queuedFilter = null;
            if (nextFilter === activeFilter) continue;

            activeFilter = nextFilter;
            await applyFilter(nextFilter);
        }

        isFilterAnimating = false;
    }

    function handleFilterClick(e) {
        const filter = e.currentTarget.getAttribute('data-filter');
        requestFilter(filter).catch(err => {
            console.error('Filter transition error:', err);
            isFilterAnimating = false;
            queuedFilter = null;
            cancelTrackedFilterAnimations();
            cancelPendingFilterPhases();
            const grid = galleryView.querySelector('.work-grid');
            if (grid) {
                grid.classList.remove('work-grid--filtering');
                grid.style.opacity = '';
                grid.style.transform = '';
            }
            updateSidebarActiveState(activeFilter);
        });

        // On phone layouts, collapse filters after a selection so content returns immediately.
        const isPhone = window.matchMedia('(max-width: 640px)').matches;
        if (isPhone) {
            const sidebar = galleryView.querySelector('.work-sidebar');
            const toggle = galleryView.querySelector('.sidebar-toggle');
            if (sidebar && sidebar.classList.contains('sidebar--open')) {
                sidebar.classList.remove('sidebar--open');
                if (toggle) toggle.setAttribute('aria-expanded', 'false');
            }
        }
    }

    function trackFilterAnimation(animation) {
        if (!animation) return animation;
        trackedFilterAnimations.add(animation);
        const cleanup = () => trackedFilterAnimations.delete(animation);
        animation.addEventListener('finish', cleanup, { once: true });
        animation.addEventListener('cancel', cleanup, { once: true });
        return animation;
    }

    function cancelTrackedFilterAnimations() {
        trackedFilterAnimations.forEach(animation => {
            try {
                animation.cancel();
            } catch (_err) {
                // Ignore animation cancellation errors from stale handles.
            }
        });
        trackedFilterAnimations.clear();
    }

    /** Schedule a timeout and track it so rapid filter clicks can cancel pending phases */
    function scheduleFilterPhase(fn, delayMs) {
        const id = window.setTimeout(() => {
            pendingFilterTimeouts.delete(id);
            fn();
        }, delayMs);
        pendingFilterTimeouts.add(id);
        return id;
    }

    /** Cancel all pending phased timeouts */
    function cancelPendingFilterPhases() {
        pendingFilterTimeouts.forEach(id => window.clearTimeout(id));
        pendingFilterTimeouts.clear();
    }

    function cellMatchesFilter(cell, filter) {
        const tags = (cell.getAttribute('data-tags') || '')
            .split(',')
            .map(tag => tag.trim())
            .filter(Boolean);
        return filter === 'all' || tags.includes(filter);
    }

    function applyFilterWithoutMotion(cells, filter) {
        cells.forEach(cell => {
            if (cellMatchesFilter(cell, filter)) {
                cell.removeAttribute('data-filtered-out');
            } else {
                cell.setAttribute('data-filtered-out', 'true');
            }
        });
    }

    function applyFilter(filter) {
        const grid = galleryView.querySelector('.work-grid');
        if (!grid) return Promise.resolve();

        const cells = Array.from(galleryView.querySelectorAll('.work-cell'));
        const prefersReducedMotion =
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const supportsElementAnimate =
            cells.length > 0 && typeof cells[0].animate === 'function';
        const runToken = ++filterAnimationToken;

        grid.classList.add('work-grid--filtering');

        if (prefersReducedMotion || !supportsElementAnimate) {
            cancelTrackedFilterAnimations();
            cancelPendingFilterPhases();
            applyFilterWithoutMotion(cells, filter);
            grid.classList.remove('work-grid--filtering');
            return Promise.resolve();
        }

        cancelTrackedFilterAnimations();
        cancelPendingFilterPhases();

        return new Promise(resolve => {
            // ── Phase 1: Fade out the grid ──
            const fadeOut = grid.animate(
                [{ opacity: 1 }, { opacity: 0 }],
                { duration: FILTER_FADE_OUT_MS, easing: FILTER_EASING, fill: 'forwards' }
            );
            trackFilterAnimation(fadeOut);

            // ── Phase 2: Swap visibility + fade in ──
            scheduleFilterPhase(() => {
                if (runToken !== filterAnimationToken) {
                    grid.style.opacity = '';
                    return resolve();
                }

                // Toggle cell visibility
                cells.forEach(cell => {
                    if (cellMatchesFilter(cell, filter)) {
                        cell.removeAttribute('data-filtered-out');
                    } else {
                        cell.setAttribute('data-filtered-out', 'true');
                    }
                });

                // Cancel the fade-out fill so we can animate back
                fadeOut.cancel();

                // Fade in with subtle upward slide
                const fadeIn = grid.animate(
                    [
                        { opacity: 0, transform: 'translateY(12px)' },
                        { opacity: 1, transform: 'translateY(0)' }
                    ],
                    { duration: FILTER_FADE_IN_MS, easing: FILTER_EASING, fill: 'forwards' }
                );
                trackFilterAnimation(fadeIn);

                fadeIn.addEventListener('finish', () => {
                    // Commit final styles and clean up
                    fadeIn.cancel();
                    grid.style.opacity = '';
                    grid.style.transform = '';
                    grid.classList.remove('work-grid--filtering');
                    resolve();
                }, { once: true });

                fadeIn.addEventListener('cancel', () => {
                    grid.style.opacity = '';
                    grid.style.transform = '';
                    grid.classList.remove('work-grid--filtering');
                    resolve();
                }, { once: true });

            }, FILTER_FADE_OUT_MS);
        });
    }

    function initMobileToggle() {
        const toggle = galleryView.querySelector('.sidebar-toggle');
        const sidebar = galleryView.querySelector('.work-sidebar');
        if (!toggle || !sidebar) return;

        toggle.addEventListener('click', () => {
            const isOpen = sidebar.classList.toggle('sidebar--open');
            toggle.setAttribute('aria-expanded', String(isOpen));
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && sidebar.classList.contains('sidebar--open')) {
                sidebar.classList.remove('sidebar--open');
                toggle.setAttribute('aria-expanded', 'false');
            }
        });

        const phoneQuery = window.matchMedia('(max-width: 640px)');
        const resetForLargerScreens = () => {
            if (!phoneQuery.matches) {
                sidebar.classList.remove('sidebar--open');
                toggle.setAttribute('aria-expanded', 'false');
            }
        };
        if (typeof phoneQuery.addEventListener === 'function') {
            phoneQuery.addEventListener('change', resetForLargerScreens);
        } else if (typeof phoneQuery.addListener === 'function') {
            phoneQuery.addListener(resetForLargerScreens);
        }
    }

    // ---- Resize: reposition sidebar indicator --------------------

    function initResizeHandler() {
        let resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                const activeBtn = galleryView.querySelector('.sidebar-link--active');
                if (activeBtn) positionIndicator(activeBtn, false);
            }, 100);
        });
    }

    // ---- Init ---------------------------------------------------

    try {
        if (projectId) {
            showDetail();
        } else {
            showGallery();
        }

        await loadManifest();
        allTags = extractTags(manifest);

        if (projectId) {
            await renderDetail(projectId);
        } else {
            await renderGallery();
            buildSidebar();
            initMobileToggle();
            initResizeHandler();
        }
    } catch (err) {
        console.error('Work page error:', err);
    }
})();
