import { BUILTIN_TEST_LOGO_SVG } from '../constants.js';

export function setupUpload({ dom, appCompat, lifecycle }) {
    const app = appCompat;
    const uploadZone = (dom && dom.uploadZone) ? dom.uploadZone : null;
    const svgInput = (dom && dom.svgInput) ? dom.svgInput : null;
    if (!app || !uploadZone || !svgInput) return;

    const headerUploadBtn = document.getElementById('header-upload-btn');
    const isSvgFile = (f) => f && (f.type === 'image/svg+xml' || f.name.toLowerCase().endsWith('.svg'));
    const isImageFile = (f) => f && (
        f.type === 'image/png' ||
        f.type === 'image/jpeg' ||
        f.type === 'image/webp' ||
        f.name.toLowerCase().endsWith('.png') ||
        f.name.toLowerCase().endsWith('.jpg') ||
        f.name.toLowerCase().endsWith('.jpeg') ||
        f.name.toLowerCase().endsWith('.webp')
    );
    const isSupportedFile = (f) => isSvgFile(f) || isImageFile(f);

    const signal = lifecycle && lifecycle.signal;
    const on = (target, type, handler, options) => {
        if (!target) return;
        const opts = signal ? { ...(options || {}), signal } : options;
        target.addEventListener(type, handler, opts);
    };

    // Click to upload
    on(uploadZone, 'click', () => {
        svgInput.click();
    });
    on(headerUploadBtn, 'click', (e) => {
        e.preventDefault();
        svgInput.click();
    });

    // Demo button (loads test-logo.svg)
    const demoBtn = document.getElementById('demo-btn');
    if (demoBtn) {
        on(demoBtn, 'click', async (e) => {
            e.stopPropagation();
            try {
                let svgString = '';
                try {
                    // NOTE: this file lives under js/app/ui/, so we need 3x ".." to reach project root.
                    const url = new URL('../../../test-logo.svg', import.meta.url);
                    const res = await fetch(url, { cache: 'no-store' });
                    if (!res.ok) throw new Error(`Failed to load demo (${res.status})`);
                    svgString = await res.text();
                } catch (_err) {
                    // Fallback: embedded demo SVG string.
                    svgString = BUILTIN_TEST_LOGO_SVG;
                }
                // Demo sequence: file + two inline icons
                const demo2 = `
                        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                            <rect x="10" y="10" width="80" height="80" rx="18" fill="#e8e8ed"/>
                            <path d="M30 30 L70 70 M70 30 L30 70" fill="none" stroke="#0a0a0f" stroke-width="10" stroke-linecap="round"/>
                        </svg>
                    `;
                const demo3 = `
                        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                            <polygon points="50,6 62,38 96,38 68,58 78,92 50,72 22,92 32,58 4,38 38,38" fill="#e8e8ed"/>
                            <circle cx="50" cy="50" r="10" fill="#0a0a0f"/>
                        </svg>
                    `;
                app.processSVGSequence([svgString, demo2, demo3]);
            } catch (err) {
                console.error(err);
                alert('Could not load demo SVG.');
            }
        });
    }

    const collectFiles = (dt) => {
        if (!dt) return [];
        const items = dt.items ? Array.from(dt.items) : [];
        const fromItems = items
            .map((item) => (item && item.kind === 'file' && typeof item.getAsFile === 'function') ? item.getAsFile() : null)
            .filter(Boolean);
        if (fromItems.length) return fromItems;
        return Array.from(dt.files || []);
    };

    // File input change
    on(svgInput, 'change', (e) => {
        const allFiles = Array.from(e.target.files || []);
        const files = allFiles.filter(isSupportedFile);
        if (allFiles.length > 0 && files.length === 0) {
            svgInput.value = '';
            alert('Unsupported file type. Please upload SVG, PNG, JPG, or WEBP files.');
            return;
        }
        if (files.length) app.handleFiles(files);
    });

    // Drag and drop
    on(uploadZone, 'dragover', (e) => {
        e.preventDefault();
        uploadZone.classList.add('dragover');
    });

    on(uploadZone, 'dragleave', () => {
        uploadZone.classList.remove('dragover');
    });

    on(uploadZone, 'drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('dragover');

        const allFiles = collectFiles(e.dataTransfer);
        const files = allFiles.filter(isSupportedFile);
        if (allFiles.length > 0 && files.length === 0) {
            alert('Unsupported file type. Please upload SVG, PNG, JPG, or WEBP files.');
        }
        if (files.length) app.handleFiles(files);
    });
}
