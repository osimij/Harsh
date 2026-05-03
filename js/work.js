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

    function scrollToPageTopInstantly() {
        const root = document.documentElement;
        const previousScrollBehavior = root.style.scrollBehavior;

        root.style.scrollBehavior = 'auto';
        if (lenisInstance) {
            lenisInstance.scrollTo(0, { immediate: true });
        }
        window.scrollTo(0, 0);
        root.scrollTop = 0;
        document.body.scrollTop = 0;

        window.requestAnimationFrame(() => {
            root.style.scrollBehavior = previousScrollBehavior;
        });
    }

    let lenisInstance = null;
    let lenisRafId = null;
    let isProjectTransitioning = false;
    const PROJECT_TRANSITION_DIM = 0.6;
    const PROJECT_EXIT_SCALE = 0.94;

    // ---- Case study preloader -----------------------------------
    const PRELOADER_FADE_MS = 380;
    const PRELOADER_FILL_HOLD_MS = 240;
    const PRELOADER_SAFETY_MS = 6000;

    let casePreloaderPathLength = 0;

    function ensureCasePreloaderPathLength() {
        if (casePreloaderPathLength) return casePreloaderPathLength;
        const shape = document.getElementById('case-preloader-shape');
        if (shape && typeof shape.getTotalLength === 'function') {
            casePreloaderPathLength = shape.getTotalLength();
            const path = document.getElementById('case-preloader-path');
            if (path) {
                path.style.strokeDasharray = String(casePreloaderPathLength);
                path.style.strokeDashoffset = String(casePreloaderPathLength);
            }
        }
        return casePreloaderPathLength;
    }

    function setCasePreloaderProgress(pct) {
        const clamped = Math.max(0, Math.min(100, pct));
        const len = ensureCasePreloaderPathLength();
        const path = document.getElementById('case-preloader-path');
        if (path && len) path.style.strokeDashoffset = String(len * (1 - clamped / 100));
        const frame = document.getElementById('case-preloader-frame');
        if (frame) frame.setAttribute('aria-valuenow', String(Math.round(clamped)));
    }

    function showCasePreloader() {
        const root = document.documentElement;
        root.classList.remove('case-preloader-fading');
        root.classList.add('case-loading');
        setCasePreloaderProgress(0);
    }

    function hideCasePreloader() {
        const root = document.documentElement;
        if (!root.classList.contains('case-loading')) return;

        root.classList.add('case-preloader-fading');
        window.setTimeout(() => {
            root.classList.remove('case-loading');
            root.classList.remove('case-preloader-fading');
            setCasePreloaderProgress(0);
        }, PRELOADER_FADE_MS);
    }

    /**
     * Track image-load progress in detailView. Resolves when at least half
     * of the images are loaded (or after a safety timeout), animates the
     * fill to 100%, then fades the preloader out.
     */
    async function runCasePreloader() {
        const root = document.documentElement;
        if (!root.classList.contains('case-loading')) return;

        const images = Array.from(detailView.querySelectorAll('img'));
        const total = images.length;

        if (!total) {
            setCasePreloaderProgress(100);
            await new Promise(resolve => window.setTimeout(resolve, PRELOADER_FILL_HOLD_MS));
            hideCasePreloader();
            return;
        }

        let loaded = 0;
        const updateProgress = () => setCasePreloaderProgress((loaded / total) * 100);

        images.forEach(img => {
            if (img.complete && img.naturalWidth > 0) loaded++;
        });
        updateProgress();

        const targetMin = Math.max(1, Math.ceil(total / 2));

        await new Promise(resolve => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                resolve();
            };

            if (loaded >= targetMin) {
                finish();
                return;
            }

            const onImageSettled = () => {
                loaded++;
                updateProgress();
                if (loaded >= targetMin) finish();
            };

            images.forEach(img => {
                if (img.complete && img.naturalWidth > 0) return;
                img.addEventListener('load', onImageSettled, { once: true });
                img.addEventListener('error', onImageSettled, { once: true });
            });

            window.setTimeout(finish, PRELOADER_SAFETY_MS);
        });

        setCasePreloaderProgress(100);
        await new Promise(resolve => window.setTimeout(resolve, PRELOADER_FILL_HOLD_MS));
        hideCasePreloader();
    }

    function clamp01(value) {
        return Math.max(0, Math.min(1, Number(value) || 0));
    }

    function startLenis() {
        if (lenisInstance || typeof window.Lenis !== 'function') return;

        lenisInstance = new window.Lenis({
            duration: 1.2,
            easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
            smoothWheel: true,
            wheelMultiplier: 1,
            touchMultiplier: 1.2,
        });

        const tick = (time) => {
            if (!lenisInstance) return;
            lenisInstance.raf(time);
            lenisRafId = window.requestAnimationFrame(tick);
        };
        lenisRafId = window.requestAnimationFrame(tick);
    }

    function stopLenis() {
        if (lenisRafId !== null) {
            window.cancelAnimationFrame(lenisRafId);
            lenisRafId = null;
        }
        if (lenisInstance) {
            lenisInstance.destroy();
            lenisInstance = null;
        }
    }

    function pauseLenis() {
        if (lenisInstance && typeof lenisInstance.stop === 'function') {
            lenisInstance.stop();
        }
    }

    function resumeLenis() {
        if (lenisInstance && typeof lenisInstance.start === 'function') {
            lenisInstance.start();
            return;
        }

        startLenis();
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getLogoSrc(project) {
        return LOGOS_DIR + project.file;
    }

    function getProjectNeighbors(project) {
        const currentIndex = manifest.findIndex(item => item.id === project.id);
        const safeIndex = currentIndex >= 0 ? currentIndex : 0;

        return Array.from({ length: 9 }, (_, offset) => {
            const index = (safeIndex + offset + 1) % manifest.length;
            return manifest[index];
        });
    }

    function getAdjacentProjects(project) {
        const currentIndex = manifest.findIndex(item => item.id === project.id);
        const safeIndex = currentIndex >= 0 ? currentIndex : 0;
        const previousIndex = (safeIndex - 1 + manifest.length) % manifest.length;
        const nextIndex = (safeIndex + 1) % manifest.length;

        return {
            previous: manifest[previousIndex],
            next: manifest[nextIndex]
        };
    }

    function getProjectRoleItems(project) {
        const tags = Array.isArray(project.tags) ? project.tags : [];
        const roleItems = ['Designer'];

        if (tags.some(tag => ['Branding', 'Identity'].includes(tag))) roleItems.push('Strategy');
        if (tags.includes('Logo')) roleItems.push('Logo');
        if (tags.includes('Identity')) roleItems.push('Identity');
        if (tags.includes('Branding') && !roleItems.includes('Identity')) roleItems.push('Branding');

        return Array.from(new Set(roleItems)).slice(0, 4);
    }

    /** Pick the most descriptive single tag for the card badge. */
    function getBadgeTag(project) {
        const tags = Array.isArray(project.tags) ? project.tags : [];
        if (!tags.length) return 'Logo';

        const priority = ['Identity', 'Corporate', 'Tech', 'Science', '3D', 'Personal', 'Streetwear', 'Branding', 'Logo'];
        for (const candidate of priority) {
            if (tags.includes(candidate)) return candidate;
        }
        return tags[0];
    }

    /** Map a tag to a CSS modifier for badge color. */
    function getBadgeVariant(tag) {
        return String(tag || '')
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-]/g, '');
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
    let detailCleanup = null;

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
    const COMPACT_CARD_TITLE_QUERY = '(max-width: 1100px)';

    function getResponsiveCardTitle(logo) {
        const fullTitle = logo.displayName || logo.name;
        const isCompact = window.matchMedia(COMPACT_CARD_TITLE_QUERY).matches;

        if (isCompact && logo.id === 'balanced-pathways') {
            return 'Balanced Pathways Corp.';
        }

        return fullTitle;
    }

    function refreshResponsiveCardTitles() {
        const cells = galleryView.querySelectorAll('.work-cell');
        if (!cells.length) return;

        cells.forEach(cell => {
            const logoId = cell.getAttribute('data-logo-id');
            if (!logoId) return;

            const logo = manifest.find(item => item.id === logoId);
            if (!logo) return;

            const titleEl = cell.querySelector('.work-cell__title');
            if (!titleEl) return;
            titleEl.textContent = getResponsiveCardTitle(logo);
        });
    }

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
        cleanupDetailView();
        stopLenis();
        galleryView.hidden = false;
        detailView.hidden  = true;
        document.documentElement.classList.remove('work-route-detail');
        document.documentElement.classList.remove('overscroll-none', 'lenis');
        document.body.classList.remove('work-detail-view');
        scrollToPageTopInstantly();
    }

    function showDetail() {
        cleanupDetailView();
        galleryView.hidden = true;
        detailView.hidden  = false;
        document.documentElement.classList.add('work-route-detail', 'overscroll-none', 'lenis');
        document.body.classList.add('work-detail-view');
        scrollToPageTopInstantly();
        if (!isProjectTransitioning) {
            startLenis();
        }
    }

    function cleanupDetailView() {
        if (typeof detailCleanup === 'function') {
            detailCleanup();
            detailCleanup = null;
        }
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
            cell.setAttribute('data-logo-id', logo.id);
            cell.setAttribute('data-tags', (logo.tags || []).join(','));

            // Show preloader synchronously on plain left-click so it's visible
            // during the navigation handoff (before the new page loads).
            cell.addEventListener('click', (event) => {
                if (event.defaultPrevented) return;
                if (event.button !== 0) return;
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                showCasePreloader();
            });

            // Brand tile: colored chip (using the project's signature
            // thumbnailBg) holding the original logo silhouette tinted
            // to its logoColor — restores the existing visual identity
            // at small size on the white card.
            let svgStr = deduplicateSvgIds(svgs[i], `wk_${logo.id}`);
            if (logo.logoColor) {
                svgStr = recolorSvg(svgStr, logo.logoColor);
            }

            // Header row — brand tile (left) + category badge (right)
            const head = document.createElement('div');
            head.className = 'work-cell__head';

            const brandTile = document.createElement('span');
            brandTile.className = 'work-cell__brand-tile';
            if (logo.thumbnailBg) {
                brandTile.style.backgroundColor = logo.thumbnailBg;
            }
            brandTile.innerHTML = svgStr;

            const svgEl = brandTile.querySelector('svg');
            if (svgEl) {
                svgEl.setAttribute('aria-hidden', 'true');
                svgEl.removeAttribute('width');
                svgEl.removeAttribute('height');
            }

            const badgeTag = getBadgeTag(logo);
            const badge = document.createElement('span');
            badge.className = `work-cell__badge work-cell__badge--${getBadgeVariant(badgeTag)}`;
            badge.textContent = badgeTag;

            head.appendChild(brandTile);
            head.appendChild(badge);

            // Body — title + description
            const body = document.createElement('div');
            body.className = 'work-cell__body';

            const titleEl = document.createElement('h3');
            titleEl.className = 'work-cell__title';
            titleEl.textContent = getResponsiveCardTitle(logo);

            const descEl = document.createElement('p');
            descEl.className = 'work-cell__desc';
            descEl.textContent = logo.description || `${logo.displayName || logo.name} — identity work.`;

            body.appendChild(titleEl);
            body.appendChild(descEl);

            cell.appendChild(head);
            cell.appendChild(body);
            grid.appendChild(cell);
        });

        refreshResponsiveCardTitles();
    }

    // ---- Detail -------------------------------------------------

    async function renderDetail(id) {
        const project = manifest.find(l => l.id === id);
        if (!project) {
            // Unknown project — redirect to gallery
            hideCasePreloader();
            window.location.href = getGalleryHref();
            return;
        }

        showDetail();

        renderCaseStudyDetail(project);
        initCaseStudyInteractions();

        // Page title
        document.title = `${project.displayName || project.name} — Harsh Bika`;

        // Track media load progress and dismiss the preloader when ready.
        // Skipped during prev/next slide transitions, which run their own
        // image-wait via playProjectWipe → waitForDetailImages.
        if (!isProjectTransitioning) {
            await runCasePreloader();
        }
    }

    function renderCaseStudyDetail(project) {
        const projectName = project.displayName || project.name;
        const projectSrc = getLogoSrc(project);
        const neighbors = getProjectNeighbors(project);
        const adjacent = getAdjacentProjects(project);
        const roleItems = getProjectRoleItems(project);
        const tags = Array.isArray(project.tags) ? project.tags.join(', ') : 'Logo, Branding';

        const galleryItems = [
            {
                type: 'image',
                tone: 'dark',
                title: projectName,
                label: 'Primary mark',
                src: projectSrc,
                caption: project.description || `${projectName} identity system.`
            },
            {
                type: 'video',
                tone: 'light',
                title: 'Motion Pass',
                label: 'Scale test',
                src: projectSrc,
                caption: 'Reduced-size read, rhythm, and contrast check.'
            },
            {
                type: 'image',
                tone: 'light',
                title: 'Clear Space',
                label: 'Construction',
                src: projectSrc,
                caption: 'Spacing and visual weight checked against a quiet grid.'
            },
            {
                type: 'video',
                tone: 'dark',
                title: 'Lockup Study',
                label: project.year || '2024',
                src: projectSrc,
                caption: `${tags} direction.`
            },
            {
                type: 'image',
                tone: 'light',
                title: 'Small Use',
                label: 'Application',
                src: projectSrc,
                caption: 'Small-size legibility before final presentation polish.'
            },
            {
                type: 'double',
                tone: 'mixed',
                title: 'Pairing',
                label: 'Alternate read',
                src: projectSrc,
                secondSrc: getLogoSrc(neighbors[0]),
                secondTitle: neighbors[0].displayName || neighbors[0].name,
                caption: 'Comparison frame against neighboring identity systems.'
            },
            {
                type: 'image',
                tone: 'light',
                title: 'Specimen',
                label: 'Type feel',
                src: projectSrc,
                caption: 'Name, category, and mark held together in one restrained sheet.'
            },
            {
                type: 'image',
                tone: 'dark',
                title: 'Crop Check',
                label: 'Edge test',
                src: projectSrc,
                caption: 'Cropped composition for sharp recognition.'
            },
            {
                type: 'video',
                tone: 'light',
                title: 'Logo Reel',
                label: 'Set view',
                src: projectSrc,
                reel: [project, neighbors[1], neighbors[2]],
                caption: 'Placed beside other marks to check distinctiveness.'
            },
            {
                type: 'video',
                tone: 'dark',
                title: 'Final Hold',
                label: 'Closing frame',
                src: projectSrc,
                caption: 'Final contrast, balance, and memory read.'
            }
        ];

        detailView.innerHTML = `
            <header class="case-header case-padding-1">
                <div class="case-header-row">
                    <a href="index.html" aria-label="Back to home" class="case-logo-link case-span-w-2">
                        <img src="Harsh-Logo.svg" alt="Harsh" class="case-logo-mark" width="28" height="28">
                    </a>
                    <nav aria-label="Primary navigation">
                        <ul class="case-header-nav">
                            <li class="case-nav-item case-span-w-1">
                                <a href="${escapeHtml(getGalleryHref())}">Work</a>
                            </li>
                            <li class="case-nav-item case-span-w-1 case-nav-mobile-wide">
                                <a href="contact.html">Contact</a>
                            </li>
                        </ul>
                    </nav>
                    <a href="${escapeHtml(getGalleryHref())}" class="case-mobile-work-link" aria-label="Back to work">
                        <span>Work</span>
                    </a>
                </div>
            </header>

            <section class="case-white-card case-span-w-screen">
                <div class="case-content-wrap case-span-w-7 case-span-ml-2-wide">
                    <div class="case-lead-block case-gutter-gap-1">
                        <div class="case-lead-col-title case-span-w-4">
                            <h3 class="case-lead-heading">${escapeHtml(projectName)}</h3>
                            <p class="case-lead-desc case-span-w-2">${escapeHtml(project.description || '')}</p>
                        </div>
                        <div class="case-lead-col-roles case-span-w-2">
                            <h3 class="case-lead-heading">ROLES</h3>
                            <ul class="case-role-list">
                                ${roleItems.map(item => `<li>${escapeHtml(item)}</li>`).join('')}
                            </ul>
                        </div>
                        <div class="case-lead-col-spacer case-span-w-1"></div>
                    </div>

                    <div class="case-gallery">
                        ${galleryItems.map((item, index) => renderCaseGalleryItem(item, index)).join('')}
                    </div>
                </div>

            </section>

            <aside class="case-thumb-nav case-margin-x-1 case-span-mr-1-wide case-span-w-1" aria-label="Project thumbnails">
                <div class="case-thumb-list case-gutter-gap-1">
                    <div class="case-thumb-marker" id="case-thumb-marker"></div>
                    ${galleryItems.map((item, index) => renderCaseThumb(item, index)).join('')}
                </div>
            </aside>

            <div class="case-scroll-prompts" aria-hidden="true">
                <div class="case-scroll-prompt-top" data-prev-wrap>
                    <p data-prev-text>Scroll Up to Previous Project</p>
                </div>
                <div class="case-scroll-prompt-bottom case-span-ml-2 case-span-w-7 case-gutter-gap-1" data-next-wrap>
                    <p class="case-span-w-1" data-next-text>Scroll Down to Next Project</p>
                    <div class="case-scroll-rule case-span-ml-1 case-span-w-5">
                        <div class="case-scroll-rule-fill" data-next-fill></div>
                    </div>
                </div>
            </div>

            <footer class="case-footer case-padding-1">
                <p class="case-scroll-pct" id="case-scroll-pct">0 %</p>
                <a href="mailto:hello@harshbika.com" class="case-footer-contact">Contact</a>
            </footer>

            <div class="case-transition-shade" data-transition-shade aria-hidden="true"></div>
        `;

        detailView.dataset.previousProject = adjacent.previous ? adjacent.previous.id : '';
        detailView.dataset.nextProject = adjacent.next ? adjacent.next.id : '';
    }

    function renderCaseGalleryItem(item, index) {
        const number = String(index + 1).padStart(2, '0');
        const toneClass = item.tone === 'dark' ? 'case-study-frame-dark' : 'case-study-frame-light';
        const logoLightClass = item.tone === 'dark' ? 'case-study-logo-light' : '';

        if (item.type === 'double') {
            return `
                <div class="case-g-item case-g-double case-span-my-2" data-thumb-key="${index}">
                    <article class="case-study-frame case-study-frame-dark case-study-frame-portrait">
                        <div class="case-study-meta"><span>${number}A</span><span>${escapeHtml(item.title)}</span></div>
                        <img src="${escapeHtml(item.src)}" alt="${escapeHtml(item.title)} mark" class="case-study-logo case-study-logo-light">
                    </article>
                    <article class="case-study-frame case-study-frame-light case-study-frame-portrait">
                        <div class="case-study-meta"><span>${number}B</span><span>${escapeHtml(item.secondTitle || 'Comparison')}</span></div>
                        <img src="${escapeHtml(item.secondSrc)}" alt="${escapeHtml(item.secondTitle || 'Comparison')} mark" class="case-study-logo">
                    </article>
                </div>
            `;
        }

        if (item.reel) {
            return `
                <div class="case-g-item case-g-video" data-thumb-key="${index}">
                    <div class="case-cover-wrap">
                        <article class="case-study-frame ${toneClass} case-study-frame-video">
                            <div class="case-study-meta"><span>${number}</span><span>${escapeHtml(item.title)}</span></div>
                            <div class="case-reel-row" aria-hidden="true">
                                ${item.reel.map(reelItem => `<img src="${escapeHtml(getLogoSrc(reelItem))}" alt="">`).join('')}
                            </div>
                        </article>
                    </div>
                </div>
            `;
        }

        const typeClass = item.type === 'video' ? 'case-g-video' : 'case-g-image';
        const inner = item.type === 'video'
            ? `<div class="case-poster-sequence" aria-hidden="true"><span></span><span></span><span></span><span></span></div>`
            : `<div class="case-study-grid-lines" aria-hidden="true"></div>`;

        return `
            <div class="case-g-item ${typeClass}" data-thumb-key="${index}">
                ${item.type === 'video' ? '<div class="case-cover-wrap">' : ''}
                    <article class="case-study-frame ${toneClass} ${item.type === 'video' ? 'case-study-frame-video' : 'case-study-frame-hero'}">
                        <div class="case-study-meta"><span>${number}</span><span>${escapeHtml(item.title)}</span></div>
                        ${inner}
                        <img src="${escapeHtml(item.src)}" alt="${escapeHtml(item.title)} mark" class="case-study-logo ${logoLightClass} ${index === 0 ? 'case-study-logo-xl' : ''}">
                        <p class="case-study-caption">${escapeHtml(item.caption || item.label || '')}</p>
                    </article>
                ${item.type === 'video' ? '</div>' : ''}
            </div>
        `;
    }

    function renderCaseThumb(item, index) {
        if (item.type === 'double') {
            return `
                <button class="case-thumb case-thumb-double" type="button" data-thumb="${index}" aria-label="Go to item ${index + 1}">
                    <div class="case-thumb-dark"><img src="${escapeHtml(item.src)}" alt=""></div>
                    <div><img src="${escapeHtml(item.secondSrc)}" alt=""></div>
                </button>
            `;
        }

        const darkClass = item.tone === 'dark' ? 'case-thumb-dark' : '';
        return `
            <button class="case-thumb ${darkClass}" type="button" data-thumb="${index}" aria-label="Go to item ${index + 1}">
                <img src="${escapeHtml(item.src)}" alt="">
            </button>
        `;
    }

    function initCaseStudyInteractions() {
        const galleryItems = Array.from(detailView.querySelectorAll('.case-g-item'));
        const thumbs = Array.from(detailView.querySelectorAll('.case-thumb'));
        const thumbMarker = detailView.querySelector('#case-thumb-marker');
        const scrollPct = detailView.querySelector('#case-scroll-pct');
        const transitionCleanup = initProjectTransition();
        let activeFrame = null;

        function updateMarkerToViewport() {
            if (!thumbMarker || !thumbs.length) return;

            const docHeight = document.documentElement.scrollHeight;
            const viewportHeight = window.innerHeight;
            if (docHeight <= 0 || viewportHeight <= 0) return;

            const firstThumb = thumbs[0];
            const lastThumb = thumbs[thumbs.length - 1];
            const trackTop = firstThumb.offsetTop;
            const trackHeight = lastThumb.offsetTop + lastThumb.offsetHeight - trackTop;

            const markerHeight = Math.min(trackHeight, (viewportHeight / docHeight) * trackHeight);

            const maxScroll = Math.max(0, docHeight - viewportHeight);
            const scrollFraction = maxScroll > 0 ? window.scrollY / maxScroll : 0;
            const markerTop = trackTop + scrollFraction * (trackHeight - markerHeight);

            thumbMarker.style.opacity = '1';
            thumbMarker.style.top = `${markerTop}px`;
            thumbMarker.style.height = `${markerHeight}px`;
        }

        function requestActiveUpdate() {
            if (activeFrame !== null) return;
            activeFrame = window.requestAnimationFrame(() => {
                activeFrame = null;
                updateMarkerToViewport();
                updateScrollPct();
            });
        }

        function updateScrollPct() {
            if (!scrollPct) return;
            const max = document.documentElement.scrollHeight - window.innerHeight;
            const pct = max > 0 ? Math.round((window.scrollY / max) * 100) : 0;
            scrollPct.textContent = `${pct} %`;
        }

        thumbs.forEach(thumb => {
            thumb.addEventListener('click', () => {
                const key = parseInt(thumb.dataset.thumb, 10);
                const target = galleryItems.find(item => item.dataset.thumbKey === String(key));
                if (!target || Number.isNaN(key)) return;
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
        });

        window.addEventListener('load', requestActiveUpdate);
        window.addEventListener('scroll', requestActiveUpdate, { passive: true });
        window.addEventListener('resize', requestActiveUpdate);
        requestActiveUpdate();

        detailCleanup = () => {
            if (activeFrame !== null) {
                window.cancelAnimationFrame(activeFrame);
                activeFrame = null;
            }
            window.removeEventListener('load', requestActiveUpdate);
            window.removeEventListener('scroll', requestActiveUpdate);
            window.removeEventListener('resize', requestActiveUpdate);
            transitionCleanup();
        };
    }

    function getMaxScroll() {
        return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    }

    function initProjectTransition() {
        const TRIGGER_PX = 1750;
        const prevWrap = detailView.querySelector('[data-prev-wrap]');
        const prevText = detailView.querySelector('[data-prev-text]');
        const nextWrap = detailView.querySelector('[data-next-wrap]');
        const nextText = detailView.querySelector('[data-next-text]');
        const nextFill = detailView.querySelector('[data-next-fill]');
        const transitionShade = detailView.querySelector('[data-transition-shade]');
        const previousProject = detailView.dataset.previousProject;
        const nextProject = detailView.dataset.nextProject;

        if (!prevWrap || !prevText || !nextWrap || !nextText || !nextFill) {
            return () => {};
        }

        let progress = 0;
        let direction = 0;
        let navigating = false;
        let lastTouchY = null;

        function atTop() {
            return window.scrollY <= 1;
        }

        function atBottom() {
            const maxScroll = getMaxScroll();
            return maxScroll > 0 && window.scrollY >= maxScroll - 1;
        }

        function lockToBoundary(activeDirection) {
            const targetY = activeDirection > 0 ? getMaxScroll() : 0;

            if (lenisInstance && typeof lenisInstance.scrollTo === 'function') {
                lenisInstance.scrollTo(targetY, { immediate: true });
            }

            window.scrollTo(0, targetY);
        }

        function setPrevVisual(value) {
            const pct = (value * 100).toFixed(4);
            setCurrentPagePreview(value);
            prevWrap.style.opacity = value > 0 ? '1' : '0';
            prevText.style.transform = value > 0 ? 'translate(0, 0%)' : 'translate(0, 50%)';
            prevText.style.filter = value > 0 ? 'blur(0px)' : 'blur(2px)';
            prevText.style.backgroundImage = `linear-gradient(to right, rgb(0,0,0) 0%, rgb(0,0,0) ${pct}%, rgb(130,130,130) ${pct}%, rgb(130,130,130) 100%)`;
        }

        function setNextVisual(value) {
            setCurrentPagePreview(value);
            nextWrap.style.opacity = value > 0 ? '1' : '0';
            nextText.style.transform = value > 0 ? 'translate(0, 0%)' : 'translate(0, 50%)';
            nextText.style.filter = value > 0 ? 'blur(0px)' : 'blur(2px)';
            nextFill.style.transform = `scaleX(${value.toFixed(4)})`;
        }

        function setCurrentPagePreview(value) {
            const amount = clamp01(value);
            setTransitionShade(amount);

            if (amount <= 0) {
                clearCurrentPagePreview();
            }
        }

        function setTransitionShade(value) {
            if (!transitionShade) return;
            transitionShade.style.opacity = String(Math.min(value * PROJECT_TRANSITION_DIM, PROJECT_TRANSITION_DIM));
        }

        function clearCurrentPagePreview() {
            detailView.classList.remove('case-transition-preview');
            detailView.style.removeProperty('--case-preview-scale');
            detailView.style.removeProperty('--case-page-origin-y');
        }

        function reset() {
            progress = 0;
            direction = 0;
            setPrevVisual(0);
            setNextVisual(0);
        }

        async function navigateToProject(projectId) {
            if (!projectId) return;
            navigating = true;
            const nextUrl = getProjectHref(projectId);
            await playProjectWipe(projectId, direction, async () => {
                window.history.pushState({ project: projectId }, '', nextUrl);
                await renderDetail(projectId);
            });
        }

        function tryFire() {
            if (progress < 1 || navigating) return;

            if (direction < 0 && previousProject) {
                navigateToProject(previousProject).catch(err => {
                    console.error('Previous project navigation failed:', err);
                    navigating = false;
                });
            } else if (direction > 0 && nextProject) {
                navigateToProject(nextProject).catch(err => {
                    console.error('Next project navigation failed:', err);
                    navigating = false;
                });
            }
        }

        function applyDelta(deltaY) {
            if (navigating || deltaY === 0) return false;
            const deltaDirection = Math.sign(deltaY);

            if (direction !== 0 && deltaDirection !== direction) {
                reset();
                return false;
            }

            if ((atBottom() || direction > 0) && deltaY > 0) {
                direction = 1;
                lockToBoundary(direction);
                progress = Math.min(1, progress + deltaY / TRIGGER_PX);
                setNextVisual(progress);
                tryFire();
                return true;
            }

            if ((atTop() || direction < 0) && deltaY < 0) {
                direction = -1;
                lockToBoundary(direction);
                progress = Math.min(1, progress + Math.abs(deltaY) / TRIGGER_PX);
                setPrevVisual(progress);
                tryFire();
                return true;
            }

            return false;
        }

        function onWheel(e) {
            if (applyDelta(e.deltaY) && e.cancelable) {
                e.preventDefault();
            }
        }

        function onTouchStart(e) {
            lastTouchY = e.touches[0] ? e.touches[0].clientY : null;
        }

        function onTouchMove(e) {
            const touch = e.touches[0];
            if (!touch || lastTouchY === null) return;
            const deltaY = lastTouchY - touch.clientY;
            lastTouchY = touch.clientY;
            if (applyDelta(deltaY) && e.cancelable) {
                e.preventDefault();
            }
        }

        function onTouchEnd() {
            lastTouchY = null;
        }

        function onScroll() {
            if (!atTop() && !atBottom() && progress > 0) reset();
        }

        setPrevVisual(0);
        setNextVisual(0);

        window.addEventListener('wheel', onWheel, { capture: true, passive: false });
        window.addEventListener('touchstart', onTouchStart, { passive: true });
        window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
        window.addEventListener('touchend', onTouchEnd);
        window.addEventListener('scroll', onScroll, { passive: true });

        return () => {
            window.removeEventListener('wheel', onWheel, { capture: true });
            window.removeEventListener('touchstart', onTouchStart);
            window.removeEventListener('touchmove', onTouchMove, { capture: true });
            window.removeEventListener('touchend', onTouchEnd);
            window.removeEventListener('scroll', onScroll);
            clearCurrentPagePreview();
        };
    }

    function createOutgoingPageLayer(initialScale = 1) {
        const layer = document.createElement('div');
        const page = detailView.cloneNode(true);
        const scrollY = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
        const capturedShade = page.querySelector('[data-transition-shade]');

        layer.className = 'case-page-outgoing';
        layer.setAttribute('aria-hidden', 'true');
        layer.style.setProperty('--case-outgoing-shade', String(PROJECT_TRANSITION_DIM));
        layer.style.setProperty('--case-exit-scale', String(PROJECT_EXIT_SCALE));

        if (capturedShade) capturedShade.remove();

        page.removeAttribute('id');
        page.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
        page.classList.remove('case-transition-preview', 'case-page-incoming', 'case-page-incoming--preparing', 'case-page-incoming--previous', 'is-visible');
        page.classList.add('case-page-outgoing__page');
        page.style.top = `${-scrollY}px`;
        page.style.setProperty('--case-page-origin-y', `${scrollY + window.innerHeight / 2}px`);
        page.style.removeProperty('--case-preview-scale');
        page.style.setProperty('--case-outgoing-scale', String(initialScale));

        layer.appendChild(page);
        document.body.appendChild(layer);
        return layer;
    }

    function waitForDetailImages() {
        const images = Array.from(detailView.querySelectorAll('img'));
        const pending = images.filter(img => !img.complete);

        if (!pending.length) return Promise.resolve();

        return new Promise(resolve => {
            let resolved = false;
            let remaining = pending.length;
            const timeout = window.setTimeout(doneAll, 450);

            function doneAll() {
                if (resolved) return;
                resolved = true;
                window.clearTimeout(timeout);
                resolve();
            }

            function done() {
                remaining -= 1;
                if (remaining > 0) return;
                doneAll();
            }

            pending.forEach(img => {
                if (img.complete) {
                    done();
                    return;
                }
                img.addEventListener('load', done, { once: true });
                img.addEventListener('error', done, { once: true });
            });
        });
    }

    function playProjectWipe(projectId, direction, renderIncomingProject, initialScale = 1) {
        const project = manifest.find(item => item.id === projectId);
        if (!project) return Promise.resolve();

        isProjectTransitioning = true;
        pauseLenis();
        const outgoingLayer = createOutgoingPageLayer(initialScale);
        detailView.classList.remove('case-transition-preview');
        detailView.style.removeProperty('--case-preview-scale');
        detailView.style.removeProperty('--case-page-origin-y');
        document.body.classList.add('case-transition-lock');
        detailView.classList.add('case-page-incoming', 'case-page-incoming--preparing');
        detailView.classList.toggle('case-page-incoming--previous', direction < 0);

        function preventTransitionScroll(event) {
            if (event.cancelable) {
                event.preventDefault();
            }
        }

        window.addEventListener('wheel', preventTransitionScroll, { capture: true, passive: false });
        window.addEventListener('touchmove', preventTransitionScroll, { capture: true, passive: false });

        return new Promise(resolve => {
            let settled = false;
            let fallbackTimer = null;

            function cleanup() {
                if (fallbackTimer !== null) {
                    window.clearTimeout(fallbackTimer);
                    fallbackTimer = null;
                }
                detailView.removeEventListener('transitionend', onIncomingTransitionEnd);
                window.removeEventListener('wheel', preventTransitionScroll, { capture: true });
                window.removeEventListener('touchmove', preventTransitionScroll, { capture: true });
                document.body.classList.remove('case-transition-lock');
                detailView.classList.remove('case-page-incoming', 'case-page-incoming--preparing', 'case-page-incoming--previous', 'is-visible');
                outgoingLayer.remove();
                isProjectTransitioning = false;
                resumeLenis();
            }

            function finish() {
                if (settled) return;
                settled = true;
                scrollToPageTopInstantly();
                cleanup();
                resolve();
            }

            function onIncomingTransitionEnd(event) {
                if (event.target === detailView) finish();
            }

            async function start() {
                if (typeof renderIncomingProject === 'function') {
                    await renderIncomingProject();
                }

                await waitForDetailImages();
                scrollToPageTopInstantly();

                // Keep the real incoming page parked offscreen before the slide starts.
                detailView.getBoundingClientRect();
                window.requestAnimationFrame(() => {
                    detailView.classList.remove('case-page-incoming--preparing');
                    detailView.getBoundingClientRect();
                    window.requestAnimationFrame(() => {
                        outgoingLayer.classList.add('is-leaving');
                        detailView.classList.add('is-visible');
                        fallbackTimer = window.setTimeout(() => {
                            if (!settled) finishSafely();
                        }, 1200);
                    });
                });
            }

            function finishSafely() {
                finish();
            }

            detailView.addEventListener('transitionend', onIncomingTransitionEnd);

            start().catch(err => {
                console.error('Project transition handoff failed:', err);
                cleanup();
                resolve();
            });
        });
    }

    async function handleHistoryChange() {
        const currentProjectId = new URLSearchParams(window.location.search).get('project');

        if (currentProjectId) {
            await renderDetail(currentProjectId);
            return;
        }

        window.location.reload();
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

        const navRect = nav.getBoundingClientRect();
        const btnRect = targetBtn.getBoundingClientRect();

        const top = btnRect.top - navRect.top;
        const left = btnRect.left - navRect.left;
        const width = btnRect.width;
        const height = btnRect.height;

        const apply = () => {
            sidebarIndicator.style.transform = `translate(${left}px, ${top}px)`;
            sidebarIndicator.style.width = `${width}px`;
            sidebarIndicator.style.height = `${height}px`;
            sidebarIndicator.style.opacity = '1';
        };

        if (!animate) {
            const prevTransition = sidebarIndicator.style.transition;
            sidebarIndicator.style.transition = 'none';
            apply();
            // Force layout, then restore transitions
            sidebarIndicator.offsetWidth;
            sidebarIndicator.style.transition = prevTransition || '';
            return;
        }

        apply();
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

    // ---- Resize: reposition sidebar indicator --------------------

    function initResizeHandler() {
        let resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                const activeBtn = galleryView.querySelector('.sidebar-link--active');
                if (activeBtn) positionIndicator(activeBtn, false);
                refreshResponsiveCardTitles();
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
            initResizeHandler();
        }

        window.addEventListener('popstate', () => {
            handleHistoryChange().catch(err => {
                console.error('History navigation error:', err);
            });
        });
    } catch (err) {
        console.error('Work page error:', err);
        hideCasePreloader();
    }
})();
