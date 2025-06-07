/**
 * Theme Manager Component
 * Handles dark mode toggle functionality and theme persistence
 */
class ThemeManager {
    constructor() {
        this.themeToggleBtn = document.getElementById('theme-toggle');
        this.themeToggleLightIcon = document.getElementById('theme-toggle-light-icon');
        this.themeToggleDarkIcon = document.getElementById('theme-toggle-dark-icon');
        
        this.init();
    }

    init() {
        // Set initial theme icons based on current theme
        this.updateIcons();
        
        // Set up event listener
        if (this.themeToggleBtn) {
            this.themeToggleBtn.addEventListener('click', () => this.toggleTheme());
        }
    }

    updateIcons() {
        const isDark = this.isDarkMode();
        
        if (this.themeToggleLightIcon && this.themeToggleDarkIcon) {
            if (isDark) {
                this.themeToggleLightIcon.classList.remove('hidden');
                this.themeToggleDarkIcon.classList.add('hidden');
            } else {
                this.themeToggleLightIcon.classList.add('hidden');
                this.themeToggleDarkIcon.classList.remove('hidden');
            }
        }
    }

    toggleTheme() {
        // Toggle icons
        if (this.themeToggleLightIcon && this.themeToggleDarkIcon) {
            this.themeToggleLightIcon.classList.toggle('hidden');
            this.themeToggleDarkIcon.classList.toggle('hidden');
        }

        // Toggle theme
        if (this.isDarkMode()) {
            this.setLightMode();
        } else {
            this.setDarkMode();
        }
    }

    setDarkMode() {
        document.documentElement.classList.add('dark');
        localStorage.setItem('theme', 'dark');
    }

    setLightMode() {
        document.documentElement.classList.remove('dark');
        localStorage.setItem('theme', 'light');
    }

    isDarkMode() {
        return localStorage.getItem('theme') === 'dark' || 
               (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }

    getCurrentTheme() {
        return this.isDarkMode() ? 'dark' : 'light';
    }
}

// Initialize theme manager when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    window.themeManager = new ThemeManager();
});

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ThemeManager;
} 