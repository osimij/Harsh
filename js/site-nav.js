/**
 * Shared primary navigation — single source of truth.
 *
 * Loaded blocking from <head> so the custom element is registered before
 * the parser reaches <site-nav>. Upgrade then runs synchronously and the
 * nav markup exists before DOMContentLoaded — required because
 * lets-work-together.js binds [data-lwt-open] at that moment via
 * querySelectorAll, not delegation.
 *
 * Per-page appearance is driven by CSS variables (see site-nav.css):
 *   --site-nav-color, --site-nav-focus-color, --site-nav-z,
 *   --site-nav-cta-sheen-{soft,mid,strong,peak}.
 */
(function () {
    const NAV_HTML = `
<nav class="site-nav" aria-label="Primary navigation">
    <a href="index.html" class="site-nav-logo-link" aria-label="Home">
        <img src="Harsh-Logo.svg" alt="Harsh" class="site-nav-logo" width="28" height="28">
    </a>
    <div class="site-nav-links">
        <div class="site-nav-text-links">
            <a href="work.html" class="site-nav-link">[WORK]</a>
            <a href="contact.html" class="site-nav-link">[CONTACT]</a>
        </div>
        <button type="button" class="site-nav-cta" data-lwt-open>Let's Work Together</button>
    </div>
    <button type="button" class="site-nav-mobile-cta" data-lwt-open aria-label="Let's Work Together">Let's Work Together</button>
</nav>`.trim();

    class SiteNav extends HTMLElement {
        connectedCallback() {
            if (this.firstElementChild) return;
            this.innerHTML = NAV_HTML;
            const nav = this.querySelector('.site-nav');
            if (!nav) return;

            const updateScrolledState = () => {
                nav.classList.toggle('site-nav--scrolled', window.scrollY > 8);
            };

            updateScrolledState();
            window.addEventListener('scroll', updateScrolledState, { passive: true });
            this._cleanupScrollState = () => {
                window.removeEventListener('scroll', updateScrolledState);
            };
        }

        disconnectedCallback() {
            if (typeof this._cleanupScrollState === 'function') {
                this._cleanupScrollState();
                this._cleanupScrollState = null;
            }
        }
    }

    if (!customElements.get('site-nav')) {
        customElements.define('site-nav', SiteNav);
    }
})();
