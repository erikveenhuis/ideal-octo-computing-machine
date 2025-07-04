class GPXApp {
    constructor(mapboxAccessToken, csrfToken) {
        this.mapManager = new GPXMapManager(mapboxAccessToken);
        this.csrfToken = csrfToken;
        this.exportManager = null; // Will be initialized when needed
        
        this.init();
    }

    init() {
        // Initialize the map
        this.mapManager.initializeMap('map');

        // Set up event listeners
        this.setupEventListeners();

        // Initialize form validation
        this.initializeFormValidation();
    }



    initializeFormValidation() {
        // Initialize GPX upload form validation
        const uploadForm = document.getElementById('uploadForm');
        if (uploadForm && window.formValidator) {
            const formId = formValidator.initForm(uploadForm, {
                validateOnBlur: true,
                validateOnInput: false,
                showErrorMessages: true,
                highlightErrors: true
            });

            // Add validation rules for GPX file input
            formValidator.addFieldValidation(formId, 'gpxFile', [
                'required',
                {
                    rule: 'fileType',
                    params: ['.gpx', 'application/gpx+xml'],
                    message: 'Please select a valid GPX file'
                },
                {
                    rule: 'fileSize',
                    params: [10 * 1024 * 1024], // 10MB limit
                    message: 'File size must be less than 10MB'
                }
            ]);

            // Store form ID for later use
            this.uploadFormId = formId;
        }
    }

    setupEventListeners() {
        // File upload handler
        document.getElementById('gpxFile').addEventListener('change', (e) => {
            this.handleFileUpload(e);
        });

        // Route controls
        document.getElementById('routeColor').addEventListener('input', (e) => {
            this.mapManager.updateRouteColor(e.target.value);
        });

        document.getElementById('routeWidth').addEventListener('input', (e) => {
            this.mapManager.updateRouteWidth(e.target.value);
        });

        // Map style change
        document.getElementById('mapStyle').addEventListener('change', (e) => {
            this.mapManager.changeMapStyle(e.target.value);
        });



        // Toggle markers
        document.getElementById('toggleMarkers').addEventListener('click', (e) => {
            this.handleMarkersToggle(e.target);
        });

        // Toggle antialiasing
        document.getElementById('toggleAntialiasing').addEventListener('click', (e) => {
            this.handleAntialiasingToggle(e.target);
        });

        // Save PNG button
        document.getElementById('savePNGBtn').addEventListener('click', () => {
            this.handleSavePNG();
        });

        // Save SVG button
        document.getElementById('saveSVGBtn').addEventListener('click', () => {
            this.handleSaveSVG();
        });

        // Toggle sidebar on mobile
        document.querySelector('.toggle-sidebar').addEventListener('click', (e) => {
            this.handleSidebarToggle(e.target);
        });

        // Handle window resize
        window.addEventListener('resize', () => {
            this.mapManager.getMap().resize();
        });
    }

    async handleFileUpload(e) {
        const fileInput = e.target;
        
        if (!fileInput.files.length) {
            showToast('Please select a file', 'error');
            return;
        }

        const formData = new FormData();
        formData.append('gpx_file', fileInput.files[0]);

        // Show loading state
        const uploadForm = fileInput.closest('form') || fileInput.closest('.controls');
        if (uploadForm && window.loadingStates) {
            window.loadingStates.setFormLoading(uploadForm);
        }

        try {
            const response = await fetch('/upload-gpx', {
                method: 'POST',
                headers: {
                    'X-CSRFToken': this.csrfToken
                },
                body: formData
            });
            
            const data = await response.json();
            
            if (data.error) {
                showToast(data.error, 'error');
                return;
            }

            // Load the GPX data into the map
            await this.mapManager.loadGPXData(data.track_points);
            showToast('Route loaded successfully!', 'success');

        } catch (error) {
            showToast('Error loading GPX file: ' + error.message, 'error');
        } finally {
            // Remove loading state
            if (uploadForm && window.loadingStates) {
                window.loadingStates.removeFormLoading(uploadForm);
            }
        }
    }

    handleMarkersToggle(button) {
        const isEnabled = !button.classList.contains('bg-gray-200');
        
        button.classList.toggle('bg-blue-600');
        button.classList.toggle('bg-gray-200');
        button.classList.toggle('dark:bg-blue-700');
        button.classList.toggle('dark:bg-gray-700');
        
        const span = button.querySelector('span');
        if (!isEnabled) {
            span.classList.remove('translate-x-0');
            span.classList.add('translate-x-5');
        } else {
            span.classList.remove('translate-x-5');
            span.classList.add('translate-x-0');
        }
        
        this.mapManager.toggleMarkers(!isEnabled);
    }

    handleAntialiasingToggle(button) {
        const isEnabled = !button.classList.contains('bg-gray-200');
        
        button.classList.toggle('bg-blue-600');
        button.classList.toggle('bg-gray-200');
        button.classList.toggle('dark:bg-blue-700');
        button.classList.toggle('dark:bg-gray-700');
        
        const span = button.querySelector('span');
        if (!isEnabled) {
            span.classList.remove('translate-x-0');
            span.classList.add('translate-x-6');
        } else {
            span.classList.remove('translate-x-6');
            span.classList.add('translate-x-0');
        }
        
        this.mapManager.toggleAntialiasing(!isEnabled);
    }



    async handleSavePNG() {
        const saveBtn = document.getElementById('savePNGBtn');
        
        // Add loading state to save button
        if (window.loadingStates) {
            window.loadingStates.setButtonLoading(saveBtn, 'Exporting...');
        }
        
        try {
            if (!this.exportManager) {
                // Lazy load the export manager
                this.exportManager = new GPXExportManager(this.mapManager);
            }
            
            await this.exportManager.saveAsPNG();
        } catch (error) {
            console.error('Error during PNG save:', error);
            showToast('PNG export failed - please try again', 'error');
        } finally {
            // Remove loading state
            if (window.loadingStates) {
                window.loadingStates.removeButtonLoading(saveBtn);
            }
        }
    }

    async handleSaveSVG() {
        const saveBtn = document.getElementById('saveSVGBtn');
        
        // Add loading state to save button
        if (window.loadingStates) {
            window.loadingStates.setButtonLoading(saveBtn, 'Creating SVG...');
        }
        
        try {
            if (!this.exportManager) {
                // Lazy load the export manager
                this.exportManager = new GPXExportManager(this.mapManager);
            }
            
            await this.exportManager.saveAsSVG();
        } catch (error) {
            console.error('Error during SVG save:', error);
            showToast('SVG export failed - please try again', 'error');
        } finally {
            // Remove loading state
            if (window.loadingStates) {
                window.loadingStates.removeButtonLoading(saveBtn);
            }
        }
    }

    handleSidebarToggle(button) {
        const sidebar = document.querySelector('.sidebar');
        const icon = button.querySelector('svg');
        sidebar.classList.toggle('collapsed');
        icon.classList.toggle('rotate-180');
        
        // Trigger a resize event to ensure the map updates its size
        setTimeout(() => {
            this.mapManager.getMap().resize();
        }, 300);
    }
} 