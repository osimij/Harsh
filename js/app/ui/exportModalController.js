export function setupExportModal({ dom, appCompat, lifecycle }) {
    const app = appCompat;
    const exportModal = (dom && dom.exportModal) ? dom.exportModal : null;
    if (!app || !exportModal) return;

    const signal = lifecycle && lifecycle.signal;
    const on = (target, type, handler, options) => {
        if (!target) return;
        const opts = signal ? { ...(options || {}), signal } : options;
        target.addEventListener(type, handler, opts);
    };

    // Close modal
    on(exportModal.querySelector('.modal-backdrop'), 'click', () => {
        exportModal.classList.remove('active');
    });

    on(exportModal.querySelector('.modal-close'), 'click', () => {
        exportModal.classList.remove('active');
    });

    // Transparent background toggle (image exports only)
    const exportTransparentBg = exportModal.querySelector('#export-transparent-bg');
    const pngBtn = exportModal.querySelector('.export-option[data-format="png"]');
    const webpBtn = exportModal.querySelector('.export-option[data-format="webp"]');
    const jpgBtn = exportModal.querySelector('.export-option[data-format="jpg"]');

    const originalDescs = {
        png: pngBtn && pngBtn.querySelector('.format-desc') ? pngBtn.querySelector('.format-desc').textContent : null,
        webp: webpBtn && webpBtn.querySelector('.format-desc') ? webpBtn.querySelector('.format-desc').textContent : null,
        jpg: jpgBtn && jpgBtn.querySelector('.format-desc') ? jpgBtn.querySelector('.format-desc').textContent : null
    };

    const updateTransparentBgUI = () => {
        const transparent = !!(exportTransparentBg && exportTransparentBg.checked);

        // JPEG doesn't support alpha; disable it when transparency is requested.
        if (jpgBtn) {
            jpgBtn.disabled = transparent;
            if (transparent) {
                jpgBtn.title = 'JPEG does not support transparency.';
            } else {
                jpgBtn.removeAttribute('title');
            }
        }

        // Update button descriptions so the UI stays truthful.
        const pngDesc = pngBtn ? pngBtn.querySelector('.format-desc') : null;
        const webpDesc = webpBtn ? webpBtn.querySelector('.format-desc') : null;
        const jpgDesc = jpgBtn ? jpgBtn.querySelector('.format-desc') : null;

        if (pngDesc && originalDescs.png != null) {
            pngDesc.textContent = transparent ? 'High quality (transparent background)' : originalDescs.png;
        }
        if (webpDesc && originalDescs.webp != null) {
            webpDesc.textContent = transparent ? 'Smaller file size (transparent background)' : originalDescs.webp;
        }
        if (jpgDesc && originalDescs.jpg != null) {
            jpgDesc.textContent = transparent ? 'Best compatibility (no transparency)' : originalDescs.jpg;
        }
    };

    if (exportTransparentBg) {
        on(exportTransparentBg, 'change', updateTransparentBgUI);
        updateTransparentBgUI();
    }

    // Export options
    exportModal.querySelectorAll('.export-option').forEach(btn => {
        on(btn, 'click', async () => {
            // Guard against overlapping exports.
            if (app.state && app.state.runtime && app.state.runtime.isExporting) return;

            const exportButtons = Array.from(exportModal.querySelectorAll('.export-option'));
            const exportResolution = document.getElementById('export-resolution');
            const exportFps = document.getElementById('export-fps');
            const transparentBg = document.getElementById('export-transparent-bg');
            const closeBtn = exportModal.querySelector('.modal-close');

            const originals = exportButtons.map((b) => ({ b, disabled: !!b.disabled }));
            exportButtons.forEach((b) => { b.disabled = true; });
            if (exportResolution) exportResolution.disabled = true;
            if (exportFps) exportFps.disabled = true;
            if (transparentBg) transparentBg.disabled = true;
            if (closeBtn) closeBtn.disabled = true;

            try {
                const format = btn.dataset.format;
                const scale = parseInt(document.getElementById('export-resolution').value, 10);
                const exportType = btn.dataset.export || 'image';
                if (exportType === 'video') {
                    const fps = parseInt(document.getElementById('export-fps').value, 10) || 30;
                    await app.exportVideo({ format, scale, fps });
                } else {
                    const transparentBackground = !!(transparentBg && transparentBg.checked);
                    await app.exportImage(format, scale, { transparentBackground });
                }
            } finally {
                for (const { b, disabled } of originals) b.disabled = disabled;
                if (exportResolution) exportResolution.disabled = false;
                if (exportFps) exportFps.disabled = false;
                if (transparentBg) transparentBg.disabled = false;
                if (closeBtn) closeBtn.disabled = false;
            }
        });
    });
}


