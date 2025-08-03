class GPXApp {
    constructor(mapboxAccessToken, csrfToken) {
        this.mapManager = new GPXMapManager(mapboxAccessToken);
        this.csrfToken = csrfToken;
        this.exportManager = null; // Will be initialized when needed
        this.uploadedRoutes = new Map(); // Track uploaded routes with their colors
        
        this.init();
    }

    init() {
        // Initialize the map
        this.mapManager.initializeMap('map');

        // Set up event listeners
        this.setupEventListeners();

        // Initialize form validation
        this.initializeFormValidation();
        
        // Initialize toggle button states
        this.initializeToggleStates();
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
            formValidator.addFieldValidation(formId, 'gpxFiles', [
                'required',
                {
                    rule: 'fileType',
                    params: ['.gpx', 'application/gpx+xml'],
                    message: 'Please select valid GPX files'
                },
                {
                    rule: 'fileSize',
                    params: [10 * 1024 * 1024], // 10MB limit per file
                    message: 'Each file must be less than 10MB'
                }
            ]);

            // Store form ID for later use
            this.uploadFormId = formId;
        }
    }

    setupEventListeners() {
        // File selection handler
        document.getElementById('gpxFiles').addEventListener('change', (e) => {
            this.handleFileSelection(e);
        });

        // Form submission handler
        document.getElementById('uploadForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleFormSubmission();
        });

        // Route controls (now for the active route)
        document.getElementById('routeColor').addEventListener('input', (e) => {
            this.mapManager.updateActiveRouteColor(e.target.value);
            // Also update the uploaded route
            if (this.mapManager.activeRouteId) {
                const uploadedRoute = this.uploadedRoutes.get(this.mapManager.activeRouteId);
                if (uploadedRoute) {
                    uploadedRoute.color = e.target.value;
                }
            }
        });

        document.getElementById('routeWidth').addEventListener('input', (e) => {
            this.mapManager.updateActiveRouteWidth(e.target.value);
            // Also update the uploaded route
            if (this.mapManager.activeRouteId) {
                const uploadedRoute = this.uploadedRoutes.get(this.mapManager.activeRouteId);
                if (uploadedRoute) {
                    uploadedRoute.width = parseInt(e.target.value, 10);
                }
            }
        });

        // Marker color controls
        document.getElementById('startMarkerColor').addEventListener('input', (e) => {
            this.mapManager.updateActiveRouteStartMarkerColor(e.target.value);
            // Also update the uploaded route
            if (this.mapManager.activeRouteId) {
                const uploadedRoute = this.uploadedRoutes.get(this.mapManager.activeRouteId);
                if (uploadedRoute) {
                    uploadedRoute.startMarkerColor = e.target.value;
                }
            }
        });

        document.getElementById('finishMarkerColor').addEventListener('input', (e) => {
            this.mapManager.updateActiveRouteFinishMarkerColor(e.target.value);
            // Also update the uploaded route
            if (this.mapManager.activeRouteId) {
                const uploadedRoute = this.uploadedRoutes.get(this.mapManager.activeRouteId);
                if (uploadedRoute) {
                    uploadedRoute.finishMarkerColor = e.target.value;
                }
            }
        });

        // Map style change
        document.getElementById('mapStyle').addEventListener('change', (e) => {
            this.mapManager.changeMapStyle(e.target.value);
        });

        // Global marker toggle removed - now handled per route

        // Anti-aliasing toggle removed - was non-functional for main map display

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
    }

    handleFileSelection(e) {
        const fileInput = e.target;
        const fileList = document.getElementById('fileList');
        const fileItems = document.getElementById('fileItems');
        const uploadBtn = document.getElementById('uploadBtn');
        
        // Trigger form validation to update the field state
        if (this.uploadFormId && window.formValidator) {
            window.formValidator.validateField(this.uploadFormId, 'gpxFiles');
        }
        
        if (!fileInput.files.length) {
            fileList.classList.add('hidden');
            uploadBtn.disabled = true;
            return;
        }

        // Clear previous file items
        fileItems.innerHTML = '';
        
        // Generate colors for each file
        const colors = this.generateColors(fileInput.files.length);
        
        // Create file items with color selection
        Array.from(fileInput.files).forEach((file, index) => {
            const fileItem = this.createFileItem(file, colors[index], index);
            fileItems.appendChild(fileItem);
        });
        
        fileList.classList.remove('hidden');
        uploadBtn.disabled = false;
    }

    createFileItem(file, defaultColor, index) {
        const fileItem = document.createElement('div');
        fileItem.className = 'flex items-center space-x-3 p-3 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-md shadow-sm';
        fileItem.innerHTML = `
            <div class="flex-1 min-w-0">
                <p class="text-sm font-medium text-gray-900 dark:text-white truncate">${file.name}</p>
                <p class="text-xs text-gray-500 dark:text-gray-400">${(file.size / 1024).toFixed(1)} KB</p>
            </div>
            <div class="flex items-center space-x-2">
                <label class="text-xs text-gray-600 dark:text-gray-400">Color:</label>
                <input type="color" 
                       class="w-8 h-8 border border-gray-300 dark:border-gray-600 rounded cursor-pointer hover:scale-105 transition-transform"
                       value="${defaultColor}"
                       data-file-index="${index}">
                <button type="button" 
                        class="text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                        onclick="gpxApp.removeFile(${index})"
                        title="Remove file">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                </button>
            </div>
        `;
        return fileItem;
    }

    generateColors(count) {
        const baseColors = [
            '#357273', '#83c3c2', '#45B7D1', '#96CEB4', '#FFEAA7',
            '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'
        ];
        
        const colors = [];
        for (let i = 0; i < count; i++) {
            colors.push(baseColors[i % baseColors.length]);
        }
        return colors;
    }

    removeFile(index) {
        const fileInput = document.getElementById('gpxFiles');
        const dt = new DataTransfer();
        
        Array.from(fileInput.files).forEach((file, i) => {
            if (i !== index) {
                dt.items.add(file);
            }
        });
        
        fileInput.files = dt.files;
        this.handleFileSelection({ target: fileInput });
    }

    async handleFormSubmission() {
        const fileInput = document.getElementById('gpxFiles');
        const uploadBtn = document.getElementById('uploadBtn');
        
        if (!fileInput.files.length) {
            showToast('Please select files to upload', 'error');
            return;
        }

        // Show loading state
        if (window.loadingStates) {
            window.loadingStates.setButtonLoading(uploadBtn, 'Uploading...');
        }

        try {
            const files = Array.from(fileInput.files);
            const colorInputs = document.querySelectorAll('input[type="color"]');
            
            // Upload each file with its selected color
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const color = colorInputs[i] ? colorInputs[i].value : this.generateColors(1)[0];
                
                await this.uploadSingleFile(file, color);
            }
            
            showToast(`Successfully uploaded ${files.length} route(s)!`, 'success');
            
            // Reset form
            fileInput.value = '';
            document.getElementById('fileList').classList.add('hidden');
            uploadBtn.disabled = true;
            
            // Clear validation state to remove any error messages
            if (this.uploadFormId && window.formValidator) {
                window.formValidator.clearFieldValidation(this.uploadFormId, 'gpxFiles');
            }
            
        } catch (error) {
            showToast('Error uploading files: ' + error.message, 'error');
        } finally {
            // Remove loading state
            if (window.loadingStates) {
                window.loadingStates.removeButtonLoading(uploadBtn);
            }
        }
    }

    async uploadSingleFile(file, color) {
        const formData = new FormData();
        formData.append('gpx_file', file);

        const response = await fetch('/upload-gpx', {
            method: 'POST',
            headers: {
                'X-CSRFToken': this.csrfToken
            },
            body: formData
        });
        
        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error);
        }

        // Get current marker colors
        const startMarkerColor = document.getElementById('startMarkerColor').value;
        const finishMarkerColor = document.getElementById('finishMarkerColor').value;

        // Store the route data with its color and marker colors
        const routeId = `route_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.uploadedRoutes.set(routeId, {
            trackPoints: data.track_points,
            color: color,
            filename: file.name,
            startMarkerColor: startMarkerColor,
            finishMarkerColor: finishMarkerColor,
            showMarkers: true // Default to showing markers
        });

        // Add the route to the map
        await this.mapManager.addRoute(routeId, data.track_points, color, file.name);
        
        // Update the route management UI
        this.updateRouteManagementUI();
    }

    updateRouteManagementUI() {
        const routeList = document.getElementById('routeList');
        
        if (this.uploadedRoutes.size === 0) {
            routeList.innerHTML = '<div class="text-xs text-gray-500 dark:text-gray-400 italic">No routes uploaded yet</div>';
            return;
        }
        
        routeList.innerHTML = '';
        
        this.uploadedRoutes.forEach((route, routeId) => {
            const routeItem = this.createRouteItem(routeId, route);
            routeList.appendChild(routeItem);
        });
    }

    createRouteItem(routeId, route) {
        const routeItem = document.createElement('div');
        const isActive = routeId === this.mapManager.activeRouteId;
        const showMarkers = route.showMarkers !== false; // Default to true if not set
        
        routeItem.className = `flex flex-col space-y-2 p-2 rounded-md border ${
            isActive 
                ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-700' 
                : 'bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600'
        }`;
        
        routeItem.innerHTML = `
            <div class="flex items-center justify-between">
                <div class="flex items-center space-x-2 flex-1 min-w-0">
                    <div class="w-3 h-3 rounded-full" style="background-color: ${route.color}"></div>
                    <span class="text-xs font-medium text-gray-900 dark:text-white break-all" title="${route.filename}">${route.filename}</span>
                    ${isActive ? '<span class="text-xs text-blue-600 dark:text-blue-400">(Active)</span>' : ''}
                </div>
                <div class="flex items-center space-x-1">
                    <div class="flex items-center space-x-1 mr-2">
                        <div class="w-2 h-2 rounded-full" style="background-color: ${route.startMarkerColor}" title="Start marker"></div>
                        <div class="w-2 h-2 rounded-full" style="background-color: ${route.finishMarkerColor}" title="Finish marker"></div>
                    </div>
                    <button type="button" 
                            class="text-xs px-2 py-1 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded"
                            onclick="gpxApp.selectRoute('${routeId}')">
                        Select
                    </button>
                    <button type="button" 
                            class="text-xs px-2 py-1 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded"
                            onclick="gpxApp.removeRoute('${routeId}')">
                        Remove
                    </button>
                </div>
            </div>
            <div class="flex items-center justify-between">
                <label class="text-xs text-gray-700 dark:text-gray-300">Show markers:</label>
                <button id="toggleMarkers_${routeId}" 
                    class="relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 ${showMarkers ? 'bg-blue-600 dark:bg-blue-700' : 'bg-gray-200 dark:bg-gray-700'}"
                    onclick="gpxApp.toggleRouteMarkers('${routeId}')">
                    <span class="pointer-events-none relative inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${showMarkers ? 'translate-x-4' : 'translate-x-0'}">
                        <span class="absolute inset-0 flex h-full w-full items-center justify-center transition-opacity" aria-hidden="true">
                            <svg class="h-2 w-2 text-gray-400" fill="none" viewBox="0 0 8 8">
                                <path d="M2 4l1-1m0 0l1-1M3 3L2 2m1 1l1 1" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" />
                            </svg>
                        </span>
                    </span>
                </button>
            </div>
        `;
        
        return routeItem;
    }

    selectRoute(routeId) {
        this.mapManager.setActiveRoute(routeId);
        
        // Sync marker colors from uploaded route to map manager
        const uploadedRoute = this.uploadedRoutes.get(routeId);
        if (uploadedRoute) {
            const mapRoute = this.mapManager.routes.get(routeId);
            if (mapRoute) {
                mapRoute.startMarkerColor = uploadedRoute.startMarkerColor;
                mapRoute.finishMarkerColor = uploadedRoute.finishMarkerColor;
                mapRoute.showMarkers = uploadedRoute.showMarkers;
            }
        }
        
        this.updateRouteManagementUI();
    }

    removeRoute(routeId) {
        this.mapManager.removeRoute(routeId);
        this.uploadedRoutes.delete(routeId);
        this.updateRouteManagementUI();
    }

    toggleRouteMarkers(routeId) {
        const route = this.uploadedRoutes.get(routeId);
        if (!route) return;
        
        // Toggle the showMarkers state
        route.showMarkers = !route.showMarkers;
        
        // Also update the map manager's route data
        const mapRoute = this.mapManager.routes.get(routeId);
        if (mapRoute) {
            mapRoute.showMarkers = route.showMarkers;
        }
        
        // Update the map manager
        this.mapManager.toggleRouteMarkers(routeId, route.showMarkers);
        
        // Update the UI
        this.updateRouteManagementUI();
    }

    // Anti-aliasing toggle method removed - was non-functional for main map display



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

    initializeToggleStates() {
        // Initialize markers toggle button state
        const markersToggle = document.getElementById('toggleMarkers');
        if (markersToggle) {
            // Set initial state based on mapManager.showMarkers
            if (this.mapManager.showMarkers) {
                markersToggle.classList.remove('bg-gray-200', 'dark:bg-gray-700');
                markersToggle.classList.add('bg-blue-600', 'dark:bg-blue-700');
                const span = markersToggle.querySelector('span');
                if (span) {
                    span.classList.remove('translate-x-0');
                    span.classList.add('translate-x-5');
                }
            } else {
                markersToggle.classList.remove('bg-blue-600', 'dark:bg-blue-700');
                markersToggle.classList.add('bg-gray-200', 'dark:bg-gray-700');
                const span = markersToggle.querySelector('span');
                if (span) {
                    span.classList.remove('translate-x-5');
                    span.classList.add('translate-x-0');
                }
            }
        }
        
        // Anti-aliasing toggle initialization removed - was non-functional for main map display
    }
} 