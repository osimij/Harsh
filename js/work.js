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
    }

    function showDetail() {
        galleryView.hidden = true;
        detailView.hidden  = false;
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
            cell.href = `work.html?project=${logo.id}`;
            cell.setAttribute('role', 'listitem');
            cell.setAttribute('aria-label', logo.displayName || logo.name);

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
            window.location.href = 'work.html';
            return;
        }

        showDetail();

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

    // ---- Init ---------------------------------------------------

    try {
        await loadManifest();

        if (projectId) {
            await renderDetail(projectId);
        } else {
            await renderGallery();
        }
    } catch (err) {
        console.error('Work page error:', err);
    }
})();
