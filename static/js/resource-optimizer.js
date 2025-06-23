/**
 * Resource Optimizer - Handles intelligent loading and caching of resources
 * This script implements various performance optimization strategies
 */

class ResourceOptimizer {
    constructor() {
        this.loadedResources = new Set();
        this.loadingPromises = new Map();
        this.init();
    }

    init() {
        // Initialize performance monitoring
        this.setupPerformanceMonitoring();
        
        // Setup resource preloading based on user behavior
        this.setupIntelligentPreloading();
        
        // Initialize intersection observer for lazy loading
        this.setupLazyLoading();
    }

    /**
     * Setup performance monitoring for resources
     */
    setupPerformanceMonitoring() {
        if ('performance' in window && 'observe' in window.PerformanceObserver.prototype) {
            const observer = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (entry.entryType === 'resource') {
                        // Log slow resources
                        if (entry.duration > 1000) {
                            console.warn(`Slow resource detected: ${entry.name} took ${entry.duration}ms`);
                        }
                    }
                }
            });
            
            observer.observe({ entryTypes: ['resource'] });
        }
    }

    /**
     * Setup intelligent preloading based on user navigation patterns
     */
    setupIntelligentPreloading() {
        // Preload resources for likely next pages
        const currentPath = window.location.pathname;
        
        // Navigation predictions based on current page
        const preloadMap = {
            '/': ['/gpx', '/image-transform'],
            '/gpx': ['/'],
            '/image-transform': ['/']
        };

        const preloadResources = preloadMap[currentPath];
        if (preloadResources) {
            // Preload resources after a short delay to not interfere with current page
            setTimeout(() => {
                this.preloadPageResources(preloadResources);
            }, 1500);
        }

        // Setup hover-based preloading for navigation links
        this.setupHoverPreloading();
        
        // Setup intersection observer for intelligent preloading
        this.setupViewportPreloading();
    }

    /**
     * Setup hover-based preloading for navigation links
     */
    setupHoverPreloading() {
        const navigationLinks = document.querySelectorAll('nav a[href^="/"]');
        
        navigationLinks.forEach(link => {
            let preloadTimeout;
            
            link.addEventListener('mouseenter', () => {
                // Add a small delay to avoid preloading on accidental hovers
                preloadTimeout = setTimeout(() => {
                    this.preloadPageResources([link.getAttribute('href')]);
                }, 100);
            });
            
            link.addEventListener('mouseleave', () => {
                if (preloadTimeout) {
                    clearTimeout(preloadTimeout);
                }
            });
        });
    }

    /**
     * Preload resources for specific pages
     */
    async preloadPageResources(pages) {
        for (const page of pages) {
            try {
                // Preload page-specific resources
                if (page === '/gpx') {
                    await this.preloadMapboxResources();
                } else if (page === '/image-transform') {
                    await this.preloadImageProcessingResources();
                }
            } catch (error) {
                console.warn(`Failed to preload resources for ${page}:`, error);
            }
        }
    }

    /**
     * Preload Mapbox resources
     */
    async preloadMapboxResources() {
        const resources = [
            'https://api.mapbox.com/mapbox-gl-js/v3.13.0/mapbox-gl.css',
            'https://api.mapbox.com/mapbox-gl-js/v3.13.0/mapbox-gl.js'
        ];

        return this.preloadResources(resources);
    }

    /**
     * Preload image processing resources
     */
    async preloadImageProcessingResources() {
        const resources = [
            'https://cdn.jsdelivr.net/npm/pica@9.0.1/dist/pica.min.js'
        ];

        return this.preloadResources(resources);
    }

    /**
     * Generic resource preloader
     */
    async preloadResources(urls) {
        const promises = urls.map(url => this.preloadResource(url));
        return Promise.allSettled(promises);
    }

    /**
     * Preload a single resource
     */
    preloadResource(url) {
        // Check if already loaded or loading
        if (this.loadedResources.has(url) || this.loadingPromises.has(url)) {
            return this.loadingPromises.get(url) || Promise.resolve();
        }

        const promise = new Promise((resolve, reject) => {
            const link = document.createElement('link');
            
            // Determine resource type
            if (url.endsWith('.css')) {
                link.rel = 'preload';
                link.as = 'style';
            } else if (url.endsWith('.js')) {
                link.rel = 'preload';
                link.as = 'script';
            } else {
                link.rel = 'prefetch';
            }
            
            link.href = url;
            link.onload = () => {
                this.loadedResources.add(url);
                resolve();
            };
            link.onerror = reject;
            
            document.head.appendChild(link);
        });

        this.loadingPromises.set(url, promise);
        return promise;
    }

    /**
     * Setup viewport-based preloading for resources
     */
    setupViewportPreloading() {
        if ('IntersectionObserver' in window) {
            const preloadObserver = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const element = entry.target;
                        
                        // Preload resources for forms when they come into view
                        if (element.tagName === 'FORM') {
                            this.preloadFormResources(element);
                        }
                        
                        // Preload navigation resources when nav comes into view
                        if (element.tagName === 'NAV') {
                            this.preloadNavigationResources();
                        }
                    }
                });
            }, { rootMargin: '50px' });

            // Observe key elements
            document.querySelectorAll('form, nav').forEach(el => {
                preloadObserver.observe(el);
            });
        }
    }

    /**
     * Setup lazy loading for images and other resources
     */
    setupLazyLoading() {
        if ('IntersectionObserver' in window) {
            const imageObserver = new IntersectionObserver((entries, observer) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const img = entry.target;
                        if (img.dataset.src) {
                            img.src = img.dataset.src;
                            img.removeAttribute('data-src');
                            observer.unobserve(img);
                        }
                    }
                });
            });

            // Observe images with data-src attribute
            document.querySelectorAll('img[data-src]').forEach(img => {
                imageObserver.observe(img);
            });
        }
    }

    /**
     * Preload resources for forms (like file upload capabilities)
     */
    preloadFormResources(form) {
        // Check if form has file input
        if (form.querySelector('input[type="file"]')) {
            this.preloadImageProcessingResources();
        }
    }

    /**
     * Preload navigation resources
     */
    preloadNavigationResources() {
        // Preload common navigation resources
        const commonResources = [
            'https://cdn.tailwindcss.com'
        ];
        
        this.preloadResources(commonResources);
    }

    /**
     * Load script asynchronously with proper error handling
     */
    static loadScript(src) {
        return new Promise((resolve, reject) => {
            // Check if script is already loaded
            if (document.querySelector(`script[src="${src}"]`)) {
                resolve();
                return;
            }

            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
            document.head.appendChild(script);
        });
    }

    /**
     * Load stylesheet asynchronously
     */
    static loadStylesheet(href) {
        return new Promise((resolve, reject) => {
            // Check if stylesheet is already loaded
            if (document.querySelector(`link[href="${href}"]`)) {
                resolve();
                return;
            }

            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = href;
            link.onload = resolve;
            link.onerror = () => reject(new Error(`Failed to load stylesheet: ${href}`));
            document.head.appendChild(link);
        });
    }

    /**
     * Get performance metrics
     */
    getPerformanceMetrics() {
        if (!('performance' in window)) return null;

        const navigation = performance.getEntriesByType('navigation')[0];
        const paint = performance.getEntriesByType('paint');

        return {
            domContentLoaded: navigation?.domContentLoadedEventEnd - navigation?.domContentLoadedEventStart,
            loadComplete: navigation?.loadEventEnd - navigation?.loadEventStart,
            firstPaint: paint.find(p => p.name === 'first-paint')?.startTime,
            firstContentfulPaint: paint.find(p => p.name === 'first-contentful-paint')?.startTime,
            totalResources: performance.getEntriesByType('resource').length
        };
    }
}

// Initialize resource optimizer when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.resourceOptimizer = new ResourceOptimizer();
    });
} else {
    window.resourceOptimizer = new ResourceOptimizer();
}

// Export for use in other modules
window.ResourceOptimizer = ResourceOptimizer; 