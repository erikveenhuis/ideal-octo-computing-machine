/**
 * Performance Monitor - Track and report render-blocking resource optimizations
 * This script measures the effectiveness of our optimization strategies
 */

class PerformanceMonitor {
    constructor() {
        this.metrics = {
            renderBlockingResources: [],
            resourceTimings: new Map(),
            paintTimings: {},
            optimizationSavings: 0
        };
        
        this.init();
    }

    init() {
        // Start monitoring immediately
        this.trackPaintTimings();
        this.trackResourceTimings();
        this.trackRenderBlockingResources();
        
        // Setup periodic reporting
        this.setupReporting();
    }

    /**
     * Track paint timings (FCP, LCP)
     */
    trackPaintTimings() {
        if ('performance' in window) {
            // Track First Paint and First Contentful Paint
            const paintObserver = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    this.metrics.paintTimings[entry.name] = entry.startTime;
                }
            });
            
            paintObserver.observe({ entryTypes: ['paint'] });

            // Track Largest Contentful Paint
            const lcpObserver = new PerformanceObserver((list) => {
                const entries = list.getEntries();
                if (entries.length > 0) {
                    this.metrics.paintTimings['largest-contentful-paint'] = entries[entries.length - 1].startTime;
                }
            });
            
            lcpObserver.observe({ entryTypes: ['largest-contentful-paint'] });
        }
    }

    /**
     * Track resource loading timings
     */
    trackResourceTimings() {
        if ('performance' in window) {
            const resourceObserver = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    this.analyzeResourceTiming(entry);
                }
            });
            
            resourceObserver.observe({ entryTypes: ['resource'] });
        }
    }

    /**
     * Analyze individual resource timing
     */
    analyzeResourceTiming(entry) {
        const timing = {
            name: entry.name,
            duration: entry.duration,
            size: entry.transferSize || entry.encodedBodySize || 0,
            isRenderBlocking: this.isRenderBlockingResource(entry),
            loadTime: entry.responseEnd - entry.startTime,
            cached: entry.transferSize === 0 && entry.decodedBodySize > 0
        };
        
        this.metrics.resourceTimings.set(entry.name, timing);
        
        // Log slow resources
        if (timing.duration > 200) {
            console.warn(`Slow resource detected: ${timing.name} (${Math.round(timing.duration)}ms)`);
        }
        
        // Celebrate cache hits
        if (timing.cached) {
            console.log(`Cache hit: ${timing.name}`);
        }
    }

    /**
     * Identify render-blocking resources
     */
    isRenderBlockingResource(entry) {
        const url = entry.name;
        
        // CSS files are render-blocking
        if (url.endsWith('.css')) {
            return true;
        }
        
        // Synchronous JavaScript in head is render-blocking
        if (url.endsWith('.js') && entry.initiatorType === 'script') {
            return true;
        }
        
        // External CDN resources that are loaded synchronously
        if (url.includes('cdn.tailwindcss.com') || 
            url.includes('cdn.jsdelivr.net') ||
            url.includes('api.mapbox.com')) {
            return true;
        }
        
        return false;
    }

    /**
     * Track render-blocking resources and calculate savings
     */
    trackRenderBlockingResources() {
        // Wait for page load to analyze resources
        window.addEventListener('load', () => {
            setTimeout(() => {
                this.analyzeRenderBlockingImpact();
            }, 1000);
        });
    }

    /**
     * Analyze the impact of render-blocking resources
     */
    analyzeRenderBlockingImpact() {
        const renderBlockingResources = Array.from(this.metrics.resourceTimings.values())
            .filter(timing => timing.isRenderBlocking);
        
        this.metrics.renderBlockingResources = renderBlockingResources;
        
        // Calculate potential savings from async loading
        const totalRenderBlockingTime = renderBlockingResources
            .reduce((total, resource) => total + resource.duration, 0);
        
        // Estimate savings (async loading typically saves 60-80% of blocking time)
        this.metrics.optimizationSavings = totalRenderBlockingTime * 0.7;
        
        console.log('Performance Analysis:', {
            renderBlockingResources: renderBlockingResources.length,
            totalBlockingTime: Math.round(totalRenderBlockingTime),
            estimatedSavings: Math.round(this.metrics.optimizationSavings),
            paintTimings: this.metrics.paintTimings
        });
    }

    /**
     * Setup periodic performance reporting
     */
    setupReporting() {
        // Report performance metrics every 30 seconds
        setInterval(() => {
            this.generateReport();
        }, 30000);
        
        // Report on page visibility change
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.generateReport();
            }
        });
    }

    /**
     * Generate comprehensive performance report
     */
    generateReport() {
        if (!('performance' in window)) return null;

        const navigation = performance.getEntriesByType('navigation')[0];
        const resources = performance.getEntriesByType('resource');
        
        const report = {
            timestamp: new Date().toISOString(),
            page: window.location.pathname,
            metrics: {
                // Core Web Vitals
                firstContentfulPaint: this.metrics.paintTimings['first-contentful-paint'],
                largestContentfulPaint: this.metrics.paintTimings['largest-contentful-paint'],
                
                // Navigation timing
                domContentLoaded: navigation?.domContentLoadedEventEnd - navigation?.domContentLoadedEventStart,
                loadComplete: navigation?.loadEventEnd - navigation?.loadEventStart,
                
                // Resource metrics
                totalResources: resources.length,
                renderBlockingResources: this.metrics.renderBlockingResources.length,
                cachedResources: Array.from(this.metrics.resourceTimings.values())
                    .filter(r => r.cached).length,
                
                // Optimization impact
                estimatedSavings: this.metrics.optimizationSavings
            },
            resourceBreakdown: this.generateResourceBreakdown()
        };
        
        // Send to console for now (could be sent to analytics service)
        console.log('Performance Report:', report);
        
        return report;
    }

    /**
     * Generate resource breakdown by type
     */
    generateResourceBreakdown() {
        const breakdown = {
            css: { count: 0, totalSize: 0, totalTime: 0 },
            js: { count: 0, totalSize: 0, totalTime: 0 },
            images: { count: 0, totalSize: 0, totalTime: 0 },
            cdn: { count: 0, totalSize: 0, totalTime: 0 }
        };
        
        for (const [url, timing] of this.metrics.resourceTimings) {
            let category = 'other';
            
            if (url.endsWith('.css')) category = 'css';
            else if (url.endsWith('.js')) category = 'js';
            else if (url.match(/\.(png|jpg|jpeg|gif|svg|webp)$/)) category = 'images';
            else if (url.includes('cdn.') || url.includes('api.')) category = 'cdn';
            
            if (breakdown[category]) {
                breakdown[category].count++;
                breakdown[category].totalSize += timing.size;
                breakdown[category].totalTime += timing.duration;
            }
        }
        
        return breakdown;
    }

    /**
     * Get current performance metrics
     */
    getCurrentMetrics() {
        return {
            ...this.metrics,
            currentReport: this.generateReport()
        };
    }

    /**
     * Test resource loading performance
     */
    async testResourceLoading() {
        const testUrls = [
            'https://cdn.tailwindcss.com',
            'https://cdn.jsdelivr.net/npm/pica@9.0.1/dist/pica.min.js'
        ];
        
        const results = [];
        
        for (const url of testUrls) {
            const startTime = performance.now();
            try {
                await fetch(url, { method: 'HEAD' });
                const endTime = performance.now();
                results.push({
                    url,
                    duration: endTime - startTime,
                    success: true
                });
            } catch (error) {
                results.push({
                    url,
                    duration: -1,
                    success: false,
                    error: error.message
                });
            }
        }
        
        console.log('Resource Loading Test Results:', results);
        return results;
    }
}

// Initialize performance monitor
window.addEventListener('DOMContentLoaded', () => {
    window.performanceMonitor = new PerformanceMonitor();
    
    // Add to global scope for debugging
    window.getPerformanceReport = () => window.performanceMonitor.generateReport();
    window.testResourceLoading = () => window.performanceMonitor.testResourceLoading();
});

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PerformanceMonitor;
} 