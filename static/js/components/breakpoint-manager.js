/**
 * Breakpoint Manager Utility
 * Provides consistent breakpoint management across JavaScript components
 */
class BreakpointManager {
    constructor() {
        // Breakpoint values matching CSS custom properties
        this.breakpoints = {
            sm: 640,
            md: 768,
            lg: 1024,
            xl: 1280,
            '2xl': 1536
        };

        // Current breakpoint state
        this.currentBreakpoint = this.getCurrentBreakpoint();
        this.listeners = new Map();

        // Set up resize listener
        this.setupResizeListener();
    }

    /**
     * Get the current breakpoint based on window width
     * @returns {string} Current breakpoint name
     */
    getCurrentBreakpoint() {
        const width = window.innerWidth;
        
        if (width >= this.breakpoints['2xl']) return '2xl';
        if (width >= this.breakpoints.xl) return 'xl';
        if (width >= this.breakpoints.lg) return 'lg';
        if (width >= this.breakpoints.md) return 'md';
        if (width >= this.breakpoints.sm) return 'sm';
        return 'xs';
    }

    /**
     * Check if current screen size is at or above specified breakpoint
     * @param {string} breakpoint - Breakpoint name (sm, md, lg, xl, 2xl)
     * @returns {boolean}
     */
    isBreakpointUp(breakpoint) {
        const currentWidth = window.innerWidth;
        const targetWidth = this.breakpoints[breakpoint];
        return targetWidth ? currentWidth >= targetWidth : false;
    }

    /**
     * Check if current screen size is below specified breakpoint
     * @param {string} breakpoint - Breakpoint name (sm, md, lg, xl, 2xl)
     * @returns {boolean}
     */
    isBreakpointDown(breakpoint) {
        return !this.isBreakpointUp(breakpoint);
    }

    /**
     * Check if current screen size is exactly at specified breakpoint
     * @param {string} breakpoint - Breakpoint name (sm, md, lg, xl, 2xl)
     * @returns {boolean}
     */
    isBreakpointOnly(breakpoint) {
        const breakpointKeys = Object.keys(this.breakpoints);
        const currentIndex = breakpointKeys.indexOf(breakpoint);
        
        if (currentIndex === -1) return false;
        
        const currentWidth = window.innerWidth;
        const minWidth = this.breakpoints[breakpoint];
        
        // If it's the largest breakpoint, only check minimum
        if (currentIndex === breakpointKeys.length - 1) {
            return currentWidth >= minWidth;
        }
        
        // Check if within range
        const nextBreakpoint = breakpointKeys[currentIndex + 1];
        const maxWidth = this.breakpoints[nextBreakpoint];
        
        return currentWidth >= minWidth && currentWidth < maxWidth;
    }

    /**
     * Get breakpoint value in pixels
     * @param {string} breakpoint - Breakpoint name
     * @returns {number|null} Breakpoint value in pixels
     */
    getBreakpointValue(breakpoint) {
        return this.breakpoints[breakpoint] || null;
    }

    /**
     * Check if screen is mobile (below lg breakpoint)
     * @returns {boolean}
     */
    isMobile() {
        return this.isBreakpointDown('lg');
    }

    /**
     * Check if screen is tablet (md to lg range)
     * @returns {boolean}
     */
    isTablet() {
        return this.isBreakpointUp('md') && this.isBreakpointDown('lg');
    }

    /**
     * Check if screen is desktop (lg and up)
     * @returns {boolean}
     */
    isDesktop() {
        return this.isBreakpointUp('lg');
    }

    /**
     * Register a callback for breakpoint changes
     * @param {string} id - Unique identifier for the listener
     * @param {Function} callback - Function to call when breakpoint changes
     */
    addBreakpointListener(id, callback) {
        this.listeners.set(id, callback);
    }

    /**
     * Remove a breakpoint listener
     * @param {string} id - Listener identifier
     */
    removeBreakpointListener(id) {
        this.listeners.delete(id);
    }

    /**
     * Set up the resize event listener
     * @private
     */
    setupResizeListener() {
        let resizeTimeout;
        
        window.addEventListener('resize', () => {
            // Debounce resize events
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                const newBreakpoint = this.getCurrentBreakpoint();
                
                if (newBreakpoint !== this.currentBreakpoint) {
                    const oldBreakpoint = this.currentBreakpoint;
                    this.currentBreakpoint = newBreakpoint;
                    
                    // Notify all listeners
                    this.listeners.forEach((callback, id) => {
                        try {
                            callback({
                                oldBreakpoint,
                                newBreakpoint,
                                isMobile: this.isMobile(),
                                isTablet: this.isTablet(),
                                isDesktop: this.isDesktop()
                            });
                        } catch (error) {
                            console.error(`Error in breakpoint listener ${id}:`, error);
                        }
                    });
                }
            }, 150);
        });
    }

    /**
     * Create a CSS media query string for the given breakpoint
     * @param {string} breakpoint - Breakpoint name
     * @param {string} direction - 'up', 'down', or 'only'
     * @returns {string} Media query string
     */
    createMediaQuery(breakpoint, direction = 'up') {
        const value = this.getBreakpointValue(breakpoint);
        if (!value) return '';

        switch (direction) {
            case 'up':
                return `(min-width: ${value}px)`;
            case 'down':
                return `(max-width: ${value - 1}px)`;
            case 'only':
                const breakpointKeys = Object.keys(this.breakpoints);
                const currentIndex = breakpointKeys.indexOf(breakpoint);
                if (currentIndex === breakpointKeys.length - 1) {
                    return `(min-width: ${value}px)`;
                }
                const nextValue = this.breakpoints[breakpointKeys[currentIndex + 1]];
                return `(min-width: ${value}px) and (max-width: ${nextValue - 1}px)`;
            default:
                return `(min-width: ${value}px)`;
        }
    }

    /**
     * Test a media query
     * @param {string} query - Media query string
     * @returns {boolean}
     */
    matchMedia(query) {
        return window.matchMedia(query).matches;
    }
}

// Create global instance
window.breakpointManager = new BreakpointManager();

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = BreakpointManager;
} 