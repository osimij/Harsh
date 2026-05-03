/**
 * Let's Work Together — anchored panel.
 *
 * The trigger button morphs into a 25vw × 65vh panel that contains the form.
 * On Cancel/close it shrinks back to the button rect and the button reappears.
 */
(function () {
    'use strict';

    const CONTACT_EMAIL = 'hello@harshbika.com';

    const ENQUIRY_OPTIONS = [
        'Identity',
        'Logo',
        'Collaboration',
        'Something else',
    ];

    function clamp(min, val, max) {
        return Math.max(min, Math.min(max, val));
    }

    function panelSize() {
        return {
            w: clamp(360, window.innerWidth * 0.32, 440),
            h: clamp(540, window.innerHeight * 0.68, 615),
        };
    }

    let modalRoot = null;
    let activeTrigger = null;
    let lastFocused = null;
    let isAnimating = false;

    function buildChips() {
        return ENQUIRY_OPTIONS.map((opt, i) => `
            <label class="lwt-chip">
                <input type="radio" name="enquiryType" value="${opt}"${i === 0 ? ' required' : ''}>
                <span>${opt}</span>
            </label>
        `).join('');
    }

    function buildModalMarkup() {
        return `
            <span class="lwt-morph-label" aria-hidden="true">Let's Work Together</span>
            <div class="lwt-card" role="document">
                <button type="button" class="lwt-close" aria-label="Close" data-lwt-close>&times;</button>

                <h3 class="lwt-title" id="lwt-title">Tell me about your project</h3>

                <form class="lwt-form" id="lwt-form" novalidate>
                    <div class="lwt-row lwt-row-line">
                        <label class="lwt-row-label" for="lwt-name">What's your name?</label>
                        <input id="lwt-name" type="text" name="name" autocomplete="name" required>
                    </div>

                    <div class="lwt-row lwt-row-line">
                        <label class="lwt-row-label" for="lwt-email">What's your email?</label>
                        <input id="lwt-email" type="email" name="email" autocomplete="email" required>
                    </div>

                    <div class="lwt-row lwt-row-chips">
                        <span class="lwt-row-label">What it's about?</span>
                        <div class="lwt-chips" role="radiogroup" aria-label="Project type">
                            ${buildChips()}
                        </div>
                    </div>

                    <div class="lwt-row lwt-row-message">
                        <label class="lwt-row-label" for="lwt-message">And your message</label>
                        <div class="lwt-textarea-wrap">
                            <textarea id="lwt-message" name="message" placeholder="You know, what are you working on, your timelines, anything I should know" required></textarea>
                        </div>
                    </div>

                    <p class="lwt-min-note">Min. project budget: $5K</p>

                    <div class="lwt-actions">
                        <button type="button" class="lwt-cancel" data-lwt-close>Cancel</button>
                        <button type="submit" class="lwt-submit">
                            <span>Send</span>
                        </button>
                    </div>
                    <p class="lwt-status" id="lwt-status" role="status" aria-live="polite"></p>
                </form>
            </div>
        `;
    }

    function ensureModal() {
        if (modalRoot) return modalRoot;
        modalRoot = document.createElement('div');
        modalRoot.className = 'lwt-modal';
        modalRoot.id = 'lwt-modal';
        modalRoot.setAttribute('role', 'dialog');
        modalRoot.setAttribute('aria-labelledby', 'lwt-title');
        modalRoot.setAttribute('aria-hidden', 'true');
        modalRoot.innerHTML = buildModalMarkup();
        document.body.appendChild(modalRoot);

        modalRoot.addEventListener('click', (e) => {
            if (e.target.closest('[data-lwt-close]')) {
                e.preventDefault();
                close();
                return;
            }
            if (e.target.closest('[data-lwt-privacy]')) {
                e.preventDefault();
                window.alert('Privacy: your details are only used to reply to your enquiry. They are never shared or stored beyond what email retention requires.');
            }
        });

        modalRoot.querySelector('#lwt-form').addEventListener('submit', onSubmit);
        return modalRoot;
    }

    function applyRect(el, rect) {
        el.style.top = rect.top + 'px';
        el.style.right = (window.innerWidth - rect.right) + 'px';
        el.style.width = rect.width + 'px';
        el.style.height = rect.height + 'px';
    }

    function applyTarget(el, anchorRect) {
        // Keep the same top/right anchor as the trigger button so the panel
        // grows downward and leftward from the button's corner.
        const size = panelSize();
        el.style.top = anchorRect.top + 'px';
        el.style.right = (window.innerWidth - anchorRect.right) + 'px';
        el.style.width = size.w + 'px';
        el.style.height = size.h + 'px';
    }

    function open(trigger) {
        const root = ensureModal();
        if (root.dataset.open === 'true' || isAnimating) return;
        if (!trigger) return;

        activeTrigger = trigger;
        lastFocused = document.activeElement;

        const rect = trigger.getBoundingClientRect();
        applyRect(root, rect);
        root.dataset.open = 'true';
        root.setAttribute('aria-hidden', 'false');

        // Force reflow so the starting rect commits before we transition.
        void root.offsetHeight;

        trigger.style.visibility = 'hidden';

        isAnimating = true;
        applyTarget(root, rect);

        const onEnd = (e) => {
            if (e.target !== root || e.propertyName !== 'width') return;
            root.removeEventListener('transitionend', onEnd);
            isAnimating = false;
            const firstField = root.querySelector('input:not([type="radio"]):not([type="checkbox"]), textarea');
            if (firstField) firstField.focus({ preventScroll: true });
        };
        root.addEventListener('transitionend', onEnd);
    }

    function close() {
        const root = modalRoot;
        if (!root || root.dataset.open !== 'true' || isAnimating) return;
        const trigger = activeTrigger;
        if (!trigger) return;

        const rect = trigger.getBoundingClientRect();
        root.dataset.closing = 'true';
        isAnimating = true;
        applyRect(root, rect);

        const onEnd = (e) => {
            if (e.target !== root || e.propertyName !== 'width') return;
            root.removeEventListener('transitionend', onEnd);

            // The panel has now shrunk to button-rect with the button's
            // border, transparent background and no shadow. Reveal the
            // actual button (its text appears at this exact moment) and
            // snap-hide the panel without transitions, so the post-close
            // style reset doesn't flicker.
            trigger.style.visibility = '';
            root.style.transition = 'none';
            root.style.opacity = '0';
            // Force the snap to commit before we tear data-closing down.
            void root.offsetHeight;

            root.dataset.open = 'false';
            delete root.dataset.closing;
            root.setAttribute('aria-hidden', 'true');

            // Clean up inline overrides on the next frame, after the snap
            // has rendered, so the panel never flashes back into view.
            requestAnimationFrame(() => {
                root.style.top = '';
                root.style.right = '';
                root.style.width = '';
                root.style.height = '';
                root.style.transition = '';
                root.style.opacity = '';
            });

            isAnimating = false;

            const status = root.querySelector('#lwt-status');
            if (status) {
                status.textContent = '';
                status.removeAttribute('data-state');
            }

            const target = (lastFocused && typeof lastFocused.focus === 'function') ? lastFocused : trigger;
            target.focus({ preventScroll: true });
            activeTrigger = null;
        };
        root.addEventListener('transitionend', onEnd);
    }

    function onSubmit(e) {
        e.preventDefault();
        const form = e.currentTarget;
        const data = new FormData(form);
        const status = modalRoot.querySelector('#lwt-status');

        const name = (data.get('name') || '').toString().trim();
        const email = (data.get('email') || '').toString().trim();
        const enquiryType = (data.get('enquiryType') || '').toString().trim();
        const message = (data.get('message') || '').toString().trim();

        if (!name || !email || !message) {
            status.textContent = 'Please fill in your name, email, and message.';
            status.setAttribute('data-state', 'error');
            return;
        }
        if (!enquiryType) {
            status.textContent = 'Pick what your enquiry is about.';
            status.setAttribute('data-state', 'error');
            return;
        }

        const subject = `[Enquiry] ${enquiryType} — ${name}`;
        const bodyLines = [
            `Name: ${name}`,
            `Email: ${email}`,
            `Enquiry: ${enquiryType}`,
            '',
            'Message:',
            message,
        ].filter(Boolean);

        const mailto = `mailto:${CONTACT_EMAIL}` +
            `?subject=${encodeURIComponent(subject)}` +
            `&body=${encodeURIComponent(bodyLines.join('\n'))}`;

        window.location.href = mailto;

        status.textContent = 'Opening your email…';
        status.setAttribute('data-state', 'success');
    }

    function bindTriggers() {
        document.querySelectorAll('[data-lwt-open]').forEach(el => {
            if (el.dataset.lwtBound === '1') return;
            el.dataset.lwtBound = '1';
            el.addEventListener('click', (e) => {
                e.preventDefault();
                open(el);
            });
        });
    }

    function onKey(e) {
        if (e.key === 'Escape' && modalRoot && modalRoot.dataset.open === 'true') {
            close();
        }
    }

    function init() {
        ensureModal();
        bindTriggers();
        document.addEventListener('keydown', onKey);
        const observer = new MutationObserver(bindTriggers);
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
