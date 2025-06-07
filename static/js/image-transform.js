/**
 * Image Transform Page Script
 * Handles image upload, validation, transformation, and preview functionality
 */
class ImageTransformApp {
    constructor() {
        this.formId = null;
        this.init();
    }

    init() {
        // Initialize form validation
        this.initializeFormValidation();
        
        // Set up event listeners
        this.setupEventListeners();
    }

    initializeFormValidation() {
        const transformForm = document.getElementById('transformForm');
        if (transformForm && window.formValidator) {
            this.formId = formValidator.initForm(transformForm, {
                validateOnBlur: true,
                validateOnInput: false,
                showErrorMessages: true,
                highlightErrors: true
            });

            // Add validation rules for image file input
            formValidator.addFieldValidation(this.formId, 'imageFile', [
                'required',
                {
                    rule: 'fileType',
                    params: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', '.jpg', '.jpeg', '.png', '.webp', '.gif'],
                    message: 'Please select a valid image file (JPG, PNG, WebP, or GIF)'
                },
                {
                    rule: 'fileSize',
                    params: [10 * 1024 * 1024], // 10MB limit
                    message: 'Image file must be less than 10MB'
                }
            ]);
        }
    }

    setupEventListeners() {
        // Preview original image
        const imageFileInput = document.getElementById('imageFile');
        if (imageFileInput) {
            imageFileInput.addEventListener('change', (e) => this.handleImagePreview(e));
        }

        // Handle form submission
        const transformForm = document.getElementById('transformForm');
        if (transformForm) {
            transformForm.addEventListener('submit', (e) => this.handleFormSubmission(e));
        }
    }

    handleImagePreview(e) {
        const file = e.target.files[0];
        const originalPreview = document.getElementById('originalPreview');
        
        if (file && originalPreview) {
            // Validate file before preview
            if (this.formId) {
                const isValid = formValidator.validateField(this.formId, 'imageFile');
                if (!isValid) {
                    originalPreview.src = '';
                    return;
                }
            }

            const reader = new FileReader();
            reader.onload = function(e) {
                originalPreview.src = e.target.result;
                originalPreview.style.display = 'block';
            };
            reader.readAsDataURL(file);
        }
    }

    async handleFormSubmission(e) {
        e.preventDefault();
        
        // Validate form before submission
        if (this.formId && !formValidator.validateForm(this.formId)) {
            return;
        }

        const fileInput = document.getElementById('imageFile');
        const file = fileInput.files[0];
        const loadingDiv = document.getElementById('loading');
        const errorDiv = document.getElementById('error');
        const submitBtn = e.target.querySelector('button[type="submit"]');
        
        if (!file) {
            this.showError('Please select an image file');
            return;
        }
        
        const formData = new FormData();
        formData.append('file', file);
        
        try {
            // Show loading states
            this.showLoading(true);
            this.hideError();
            if (submitBtn && window.loadingStates) {
                loadingStates.setButtonLoading(submitBtn, 'Transforming...');
            }
            
            const response = await fetch('/transform-image', {
                method: 'POST',
                headers: {
                    'X-CSRFToken': this.getCSRFToken()
                },
                body: formData
            });
            
            const data = await response.json();
            
            if (data.error) {
                this.showError(data.error);
                return;
            }
            
            // Display transformed image with fade-in animation
            this.displayTransformedImage(data.image_url);
            
            // Show success toast
            if (window.showToast) {
                showToast('Image transformed successfully!', 'success');
            }
            
        } catch (error) {
            console.error('Transform error:', error);
            this.showError('An error occurred while transforming the image. Please try again.');
        } finally {
            this.showLoading(false);
            if (submitBtn && window.loadingStates) {
                loadingStates.removeButtonLoading(submitBtn);
            }
        }
    }

    displayTransformedImage(imageUrl) {
        const transformedPreview = document.getElementById('transformedPreview');
        if (transformedPreview) {
            transformedPreview.innerHTML = `
                <img src="${imageUrl}" 
                     class="w-full h-64 object-contain fade-in" 
                     alt="Transformed image"
                     style="opacity: 0; transition: opacity 0.3s ease-in-out;"
                     onload="this.style.opacity = 1;" />
            `;
        }
    }

    showLoading(show) {
        const loadingDiv = document.getElementById('loading');
        if (loadingDiv) {
            if (show) {
                loadingDiv.classList.remove('hidden');
                loadingDiv.classList.add('fade-in');
            } else {
                loadingDiv.classList.add('hidden');
                loadingDiv.classList.remove('fade-in');
            }
        }
    }

    showError(message) {
        const errorDiv = document.getElementById('error');
        if (errorDiv) {
            errorDiv.textContent = message;
            errorDiv.classList.remove('hidden');
            errorDiv.classList.add('fade-in');
        }
    }

    hideError() {
        const errorDiv = document.getElementById('error');
        if (errorDiv) {
            errorDiv.classList.add('hidden');
            errorDiv.classList.remove('fade-in');
        }
    }

    getCSRFToken() {
        // Try to get CSRF token from meta tag or cookie
        const metaToken = document.querySelector('meta[name="csrf-token"]');
        if (metaToken) {
            return metaToken.getAttribute('content');
        }
        
        // Fallback to extracting from cookie or other sources
        const cookies = document.cookie.split(';');
        for (let cookie of cookies) {
            const [name, value] = cookie.trim().split('=');
            if (name === 'csrf_token') {
                return decodeURIComponent(value);
            }
        }
        
        return '';
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    new ImageTransformApp();
}); 