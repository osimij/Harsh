/**
 * Heuristic SVG sanitizer for "logo" usage:
 * - Removes obvious full-canvas background <rect> layers that dominate sampling.
 * - Keeps the rest of the SVG intact (paths, groups, masks, etc).
 *
 * This is intentionally conservative: we only remove background rects when there
 * are other drawable elements present.
 */
export function sanitizeSvgForLogo(svgString) {
    const input = String(svgString || '').trim();
    if (!input) return input;

    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(input, 'image/svg+xml');
        const svg = doc.querySelector('svg');
        if (!svg) return input;

        // If parsing failed, keep original.
        if (doc.querySelector('parsererror')) return input;

        // Determine viewBox bounds
        let vb = svg.getAttribute('viewBox');
        let vbX = 0, vbY = 0, vbW = 0, vbH = 0;
        if (vb) {
            const parts = vb.split(/[\s,]+/).map((n) => parseFloat(n));
            if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
                [vbX, vbY, vbW, vbH] = parts;
            }
        }
        if (!(vbW > 0 && vbH > 0)) {
            vbW = parseFloat(svg.getAttribute('width')) || 0;
            vbH = parseFloat(svg.getAttribute('height')) || 0;
        }

        const rects = Array.from(svg.querySelectorAll('rect'));
        if (!rects.length || !(vbW > 0 && vbH > 0)) return input;

        // Count other drawable elements; only remove backgrounds when there's something else to show.
        const drawableSelector = 'path,circle,ellipse,polygon,polyline,line,use,image,text';
        const otherDrawables = Array.from(svg.querySelectorAll(drawableSelector))
            .filter((el) => el.tagName.toLowerCase() !== 'rect');

        if (otherDrawables.length === 0) return input;

        // Preserve structural rects that are not visible background layers (e.g. Figma clip paths).
        const protectedContainerSelector = 'defs,clipPath,clippath,mask,symbol,pattern,marker,linearGradient,lineargradient,radialGradient,radialgradient,filter';
        const referencedIds = new Set();
        for (const el of Array.from(svg.querySelectorAll('*'))) {
            const names = (typeof el.getAttributeNames === 'function') ? el.getAttributeNames() : [];
            for (const attr of names) {
                const raw = el.getAttribute(attr);
                if (!raw) continue;
                const value = String(raw).trim();
                if (!value) continue;

                // href/xlink:href direct references
                if ((attr === 'href' || attr === 'xlink:href') && value.startsWith('#')) {
                    referencedIds.add(value.slice(1).trim());
                }

                // url(#id) references inside attributes/styles like clip-path, mask, filter, fill, stroke, etc.
                const re = /url\(\s*#([^)]+)\s*\)/g;
                let match;
                while ((match = re.exec(value)) !== null) {
                    const refId = String(match[1] || '').trim();
                    if (refId) referencedIds.add(refId);
                }
            }
        }

        const approxEq = (a, b, tol) => Math.abs(a - b) <= tol;
        const tolX = Math.max(1e-3, vbW * 0.01);
        const tolY = Math.max(1e-3, vbH * 0.01);

        for (const r of rects) {
            if (r.closest(protectedContainerSelector)) continue;

            const id = String(r.getAttribute('id') || '').trim();
            if (id && referencedIds.has(id)) continue;

            const fill = (r.getAttribute('fill') || '').trim().toLowerCase();
            const style = (r.getAttribute('style') || '').toLowerCase();
            const hasVisibleFill = (fill && fill !== 'none' && fill !== 'transparent') ||
                (style.includes('fill:') && !style.includes('fill:none') && !style.includes('fill: none'));
            if (!hasVisibleFill) continue;

            const xAttr = (r.getAttribute('x') || '').trim();
            const yAttr = (r.getAttribute('y') || '').trim();
            const wAttr = (r.getAttribute('width') || '').trim();
            const hAttr = (r.getAttribute('height') || '').trim();

            // Percent-based full-cover rects
            const percentFull = (v) => v === '100%' || v === '99.9%' || v === '100.0%';
            const isPercentCover = percentFull(wAttr) && percentFull(hAttr) && (!xAttr || xAttr === '0' || xAttr === '0%') && (!yAttr || yAttr === '0' || yAttr === '0%');

            let x = parseFloat(xAttr);
            let y = parseFloat(yAttr);
            let w = parseFloat(wAttr);
            let h = parseFloat(hAttr);
            if (!Number.isFinite(x)) x = 0;
            if (!Number.isFinite(y)) y = 0;

            const isNumericCover = Number.isFinite(w) && Number.isFinite(h) &&
                w > 0 && h > 0 &&
                approxEq(x, vbX, tolX) &&
                approxEq(y, vbY, tolY) &&
                (w >= vbW * 0.98) &&
                (h >= vbH * 0.98);

            if (isPercentCover || isNumericCover) {
                // Remove likely background rect
                r.remove();
            }
        }

        return new XMLSerializer().serializeToString(svg);
    } catch (_e) {
        return input;
    }
}
