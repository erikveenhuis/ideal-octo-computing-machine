/**
 * Loading States Utility
 * Provides methods to add/remove loading states for buttons, forms, and elements
 */
class LoadingStates {
    constructor() {
        this.loadingElements = new Map();
    }

    /**
     * Add loading state to a button
     * @param {string|HTMLElement} element - Element ID or DOM element
     * @param {string} loadingText - Optional loading text
     */
    setButtonLoading(element, loadingText = null) {
        const btn = this.getElement(element);
        if (!btn) return;

        // Store original state
        const originalState = {
            text: btn.textContent,
            disabled: btn.disabled,
            classes: btn.className
        };
        this.loadingElements.set(btn, originalState);

        // Apply loading state
        btn.disabled = true;
        btn.classList.add('btn-loading');
        
        if (loadingText) {
            btn.textContent = loadingText;
        }
    }

    /**
     * Remove loading state from a button
     * @param {string|HTMLElement} element - Element ID or DOM element
     */
    removeButtonLoading(element) {
        const btn = this.getElement(element);
        if (!btn) return;

        const originalState = this.loadingElements.get(btn);
        if (!originalState) return;

        // Restore original state
        btn.disabled = originalState.disabled;
        btn.textContent = originalState.text;
        btn.classList.remove('btn-loading');

        this.loadingElements.delete(btn);
    }

    /**
     * Add loading state to any element
     * @param {string|HTMLElement} element - Element ID or DOM element
     */
    setElementLoading(element) {
        const el = this.getElement(element);
        if (!el) return;

        // Store original state
        const originalState = {
            classes: el.className
        };
        this.loadingElements.set(el, originalState);

        el.classList.add('loading');
    }

    /**
     * Remove loading state from any element
     * @param {string|HTMLElement} element - Element ID or DOM element
     */
    removeElementLoading(element) {
        const el = this.getElement(element);
        if (!el) return;

        el.classList.remove('loading');
        this.loadingElements.delete(el);
    }

    /**
     * Add loading state to a form and disable all inputs
     * @param {string|HTMLElement} form - Form ID or DOM element
     */
    setFormLoading(form) {
        const formEl = this.getElement(form);
        if (!formEl) return;

        // Store original state of all form elements
        const formElements = formEl.querySelectorAll('input, button, select, textarea');
        const originalStates = [];

        formElements.forEach(element => {
            originalStates.push({
                element: element,
                disabled: element.disabled
            });
            element.disabled = true;
        });

        this.loadingElements.set(formEl, { formElements: originalStates });
        formEl.classList.add('loading');
    }

    /**
     * Remove loading state from a form and restore inputs
     * @param {string|HTMLElement} form - Form ID or DOM element
     */
    removeFormLoading(form) {
        const formEl = this.getElement(form);
        if (!formEl) return;

        const originalState = this.loadingElements.get(formEl);
        if (!originalState) return;

        // Restore original state of all form elements
        originalState.formElements.forEach(({ element, disabled }) => {
            element.disabled = disabled;
        });

        formEl.classList.remove('loading');
        this.loadingElements.delete(formEl);
    }

    /**
     * Show loading overlay on an element
     * @param {string|HTMLElement} element - Element ID or DOM element
     * @param {string} message - Loading message
     */
    showLoadingOverlay(element, message = 'Loading...') {
        const el = this.getElement(element);
        if (!el) return;

        // Create overlay
        const overlay = document.createElement('div');
        overlay.className = 'loading-overlay';
        overlay.innerHTML = `
            <div class="loading-overlay-content">
                <div class="loading-spinner"></div>
                <div class="loading-message">${message}</div>
            </div>
        `;

        // Add overlay styles
        overlay.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(255, 255, 255, 0.9);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            border-radius: inherit;
        `;

        // Make parent relative if needed
        const originalPosition = getComputedStyle(el).position;
        if (originalPosition === 'static') {
            el.style.position = 'relative';
        }

        el.appendChild(overlay);
        this.loadingElements.set(el, { overlay, originalPosition });
    }

    /**
     * Hide loading overlay from an element
     * @param {string|HTMLElement} element - Element ID or DOM element
     */
    hideLoadingOverlay(element) {
        const el = this.getElement(element);
        if (!el) return;

        const state = this.loadingElements.get(el);
        if (!state || !state.overlay) return;

        // Remove overlay
        if (state.overlay.parentNode) {
            state.overlay.parentNode.removeChild(state.overlay);
        }

        // Restore original position if it was changed
        if (state.originalPosition === 'static') {
            el.style.position = '';
        }

        this.loadingElements.delete(el);
    }

    /**
     * Clear all loading states
     */
    clearAll() {
        this.loadingElements.forEach((state, element) => {
            if (element.tagName === 'BUTTON') {
                this.removeButtonLoading(element);
            } else if (element.tagName === 'FORM') {
                this.removeFormLoading(element);
            } else if (state.overlay) {
                this.hideLoadingOverlay(element);
            } else {
                this.removeElementLoading(element);
            }
        });
    }

    /**
     * Helper to get DOM element from string ID or element
     * @param {string|HTMLElement} element
     * @returns {HTMLElement|null}
     */
    getElement(element) {
        if (typeof element === 'string') {
            return document.getElementById(element);
        }
        return element instanceof HTMLElement ? element : null;
    }

    /**
     * Check if element is currently loading
     * @param {string|HTMLElement} element
     * @returns {boolean}
     */
    isLoading(element) {
        const el = this.getElement(element);
        return el ? this.loadingElements.has(el) : false;
    }
}

// Create global instance
window.loadingStates = new LoadingStates();

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = LoadingStates;
} 