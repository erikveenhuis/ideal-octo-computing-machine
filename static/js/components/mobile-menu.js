/**
 * Mobile Menu Component
 * Handles mobile navigation menu toggle functionality
 */
class MobileMenu {
    constructor() {
        this.menuButton = document.getElementById('mobile-menu-button');
        this.mobileMenu = document.getElementById('mobile-menu');
        this.isOpen = false;
        
        this.init();
    }

    init() {
        if (this.menuButton) {
            this.menuButton.addEventListener('click', () => this.toggle());
        }

        // Close menu when clicking outside
        document.addEventListener('click', (e) => {
            if (this.isOpen && 
                !this.mobileMenu?.contains(e.target) && 
                !this.menuButton?.contains(e.target)) {
                this.close();
            }
        });

        // Close menu on escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) {
                this.close();
            }
        });

        // Close menu when screen size changes to desktop
        if (window.breakpointManager) {
            window.breakpointManager.addBreakpointListener('mobile-menu', (data) => {
                if (data.isDesktop && this.isOpen) {
                    this.close();
                }
            });
        }

        // Handle menu item clicks
        this.setupMenuItemHandlers();
    }

    setupMenuItemHandlers() {
        if (!this.mobileMenu) return;

        const menuItems = this.mobileMenu.querySelectorAll('a');
        menuItems.forEach(item => {
            item.addEventListener('click', () => {
                // Close menu when navigating
                this.close();
            });
        });
    }

    toggle() {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    open() {
        if (!this.mobileMenu) return;

        this.mobileMenu.classList.remove('hidden');
        this.mobileMenu.classList.add('fade-in');
        this.isOpen = true;

        // Add aria attributes for accessibility
        if (this.menuButton) {
            this.menuButton.setAttribute('aria-expanded', 'true');
        }

        // Trap focus within menu
        this.trapFocus();
    }

    close() {
        if (!this.mobileMenu) return;

        this.mobileMenu.classList.add('hidden');
        this.mobileMenu.classList.remove('fade-in');
        this.isOpen = false;

        // Update aria attributes
        if (this.menuButton) {
            this.menuButton.setAttribute('aria-expanded', 'false');
        }

        // Return focus to menu button
        if (this.menuButton) {
            this.menuButton.focus();
        }
    }

    trapFocus() {
        if (!this.mobileMenu) return;

        const focusableElements = this.mobileMenu.querySelectorAll(
            'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])'
        );

        if (focusableElements.length === 0) return;

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        // Focus first element
        firstElement.focus();

        // Handle tab key to trap focus
        this.mobileMenu.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                if (e.shiftKey) {
                    // Shift + Tab
                    if (document.activeElement === firstElement) {
                        e.preventDefault();
                        lastElement.focus();
                    }
                } else {
                    // Tab
                    if (document.activeElement === lastElement) {
                        e.preventDefault();
                        firstElement.focus();
                    }
                }
            }
        });
    }

    // Public method to check if menu is open
    isMenuOpen() {
        return this.isOpen;
    }
}

// Initialize mobile menu when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    window.mobileMenu = new MobileMenu();
});

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MobileMenu;
} 