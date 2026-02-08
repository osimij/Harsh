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

    // Demo button (loads logos from manifest, falls back to test-logo.svg)
    const demoBtn = document.getElementById('demo-btn');
    if (demoBtn) {
        on(demoBtn, 'click', async (e) => {
            e.stopPropagation();
            try {
                let demoSvgs = [];
                try {
                    // Try loading first 3 logos from the centralized manifest
                    const manifestUrl = new URL('../../../assets/logos/logos.json', import.meta.url);
                    const manifestRes = await fetch(manifestUrl, { cache: 'no-store' });
                    if (!manifestRes.ok) throw new Error(`Manifest ${manifestRes.status}`);
                    const manifest = await manifestRes.json();
                    const logos = manifest.logos.slice(0, 3);
                    const fetches = logos.map(logo => {
                        const svgUrl = new URL(`../../../assets/logos/${logo.file}`, import.meta.url);
                        return fetch(svgUrl, { cache: 'no-store' }).then(r => {
                            if (!r.ok) throw new Error(`${logo.file} ${r.status}`);
                            return r.text();
                        });
                    });
                    demoSvgs = await Promise.all(fetches);
                } catch (_manifestErr) {
                    // Fallback: load test-logo.svg + inline demos (works on file:// protocol)
                    let svgString = '';
                    try {
                        const url = new URL('../../../test-logo.svg', import.meta.url);
                        const res = await fetch(url, { cache: 'no-store' });
                        if (!res.ok) throw new Error(`Failed to load demo (${res.status})`);
                        svgString = await res.text();
                    } catch (_err) {
                        svgString = BUILTIN_TEST_LOGO_SVG;
                    }
                    const demo2 = `
                        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                            <rect x="10" y="10" width="80" height="80" rx="18" fill="#e8e8ed"/>
                            <path d="M30 30 L70 70 M70 30 L30 70" fill="none" stroke="#0a0a0f" stroke-width="10" stroke-linecap="round"/>
                        </svg>`;
                    const demo3 = `
                        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                            <polygon points="50,6 62,38 96,38 68,58 78,92 50,72 22,92 32,58 4,38 38,38" fill="#e8e8ed"/>
                            <circle cx="50" cy="50" r="10" fill="#0a0a0f"/>
                        </svg>`;
                    demoSvgs = [svgString, demo2, demo3];
                }
                app.processSVGSequence(demoSvgs);
            } catch (err) {
                console.error(err);
                alert('Could not load demo SVG.');
            }
        });
    }

    // File input change
    on(svgInput, 'change', (e) => {
        const files = Array.from(e.target.files || []).filter(isSupportedFile);
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

        const files = Array.from(e.dataTransfer.files || []).filter(isSupportedFile);
        if (files.length) app.handleFiles(files);
    });
}
