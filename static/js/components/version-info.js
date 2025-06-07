/**
 * Version Info Component
 * Handles version information dropdown functionality
 */
class VersionInfo {
    constructor() {
        this.versionToggle = document.getElementById('version-toggle');
        this.versionDropdown = document.getElementById('version-dropdown');
        this.isLoaded = false;
        
        this.init();
    }

    init() {
        if (this.versionToggle) {
            this.versionToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleDropdown();
            });
        }

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!this.versionDropdown?.contains(e.target) && !this.versionToggle?.contains(e.target)) {
                this.hideDropdown();
            }
        });

        // Close on escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.hideDropdown();
            }
        });
    }

    toggleDropdown() {
        if (!this.versionDropdown) return;

        if (this.versionDropdown.classList.contains('hidden')) {
            this.showDropdown();
        } else {
            this.hideDropdown();
        }
    }

    showDropdown() {
        if (!this.versionDropdown) return;

        this.versionDropdown.classList.remove('hidden');
        this.versionDropdown.classList.add('fade-in');
        
        // Load version info if not already loaded
        if (!this.isLoaded) {
            this.loadVersionInfo();
        }
    }

    hideDropdown() {
        if (!this.versionDropdown) return;

        this.versionDropdown.classList.add('hidden');
        this.versionDropdown.classList.remove('fade-in');
    }

    async loadVersionInfo() {
        const elements = {
            commit: document.getElementById('version-commit'),
            branch: document.getElementById('version-branch'),
            author: document.getElementById('version-author'),
            date: document.getElementById('version-date'),
            message: document.getElementById('version-message')
        };

        try {
            const response = await fetch('/version');
            const data = await response.json();

            if (elements.commit) elements.commit.textContent = data.commit?.slice(0, 8) || 'Unknown';
            if (elements.branch) elements.branch.textContent = data.branch || 'Unknown';
            if (elements.author) elements.author.textContent = data.author || 'Unknown';
            if (elements.date) elements.date.textContent = this.formatDate(data.date) || 'Unknown';
            if (elements.message) elements.message.textContent = data.message || 'No message';

            this.isLoaded = true;
        } catch (error) {
            console.error('Failed to load version info:', error);
            
            // Set error state
            Object.values(elements).forEach(element => {
                if (element) element.textContent = 'Error';
            });
        }
    }

    formatDate(dateString) {
        if (!dateString) return 'Unknown';
        
        try {
            const date = new Date(dateString);
            return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch (error) {
            return dateString;
        }
    }

    // Public method to refresh version info
    refresh() {
        this.isLoaded = false;
        if (!this.versionDropdown?.classList.contains('hidden')) {
            this.loadVersionInfo();
        }
    }
}

// Initialize version info when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    window.versionInfo = new VersionInfo();
});

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = VersionInfo;
} 