/**
 * Form Validator Utility
 * Provides comprehensive client-side form validation with visual feedback
 */
class FormValidator {
    constructor() {
        this.validators = new Map();
        this.validationRules = this.getDefaultRules();
        this.messages = this.getDefaultMessages();
    }

    /**
     * Initialize validation for a form
     * @param {string|HTMLElement} form - Form element or ID
     * @param {Object} options - Validation options
     */
    initForm(form, options = {}) {
        const formElement = this.getElement(form);
        if (!formElement) return;

        const config = {
            validateOnBlur: true,
            validateOnInput: false,
            showErrorMessages: true,
            highlightErrors: true,
            stopOnFirstError: false,
            ...options
        };

        // Store form configuration
        const formId = formElement.id || this.generateId();
        formElement.id = formId;

        this.validators.set(formId, {
            element: formElement,
            config,
            fields: new Map(),
            isValid: false
        });

        // Set up form event listeners
        this.setupFormListeners(formElement, config);

        return formId;
    }

    /**
     * Add validation rules to a field
     * @param {string} formId - Form identifier
     * @param {string} fieldName - Field name or ID
     * @param {Array|Object} rules - Validation rules
     */
    addFieldValidation(formId, fieldName, rules) {
        const validator = this.validators.get(formId);
        if (!validator) return;

        const field = this.getFieldElement(validator.element, fieldName);
        if (!field) return;

        // Normalize rules to array format
        const normalizedRules = Array.isArray(rules) ? rules : [rules];

        validator.fields.set(fieldName, {
            element: field,
            rules: normalizedRules,
            isValid: false,
            errors: []
        });

        // Set up field event listeners
        this.setupFieldListeners(field, formId, fieldName, validator.config);
    }

    /**
     * Validate a specific field
     * @param {string} formId - Form identifier
     * @param {string} fieldName - Field name
     * @returns {boolean} Is field valid
     */
    validateField(formId, fieldName) {
        const validator = this.validators.get(formId);
        if (!validator) return false;

        const fieldData = validator.fields.get(fieldName);
        if (!fieldData) return false;

        const { element, rules } = fieldData;
        const value = this.getFieldValue(element);
        const errors = [];

        // Run all validation rules
        for (const rule of rules) {
            const result = this.runValidationRule(rule, value, element);
            if (!result.isValid) {
                errors.push(result.message);
                if (validator.config.stopOnFirstError) break;
            }
        }

        // Update field state
        fieldData.isValid = errors.length === 0;
        fieldData.errors = errors;

        // Update UI
        this.updateFieldUI(element, fieldData, validator.config);

        return fieldData.isValid;
    }

    /**
     * Validate entire form
     * @param {string} formId - Form identifier
     * @returns {boolean} Is form valid
     */
    validateForm(formId) {
        const validator = this.validators.get(formId);
        if (!validator) return false;

        let isFormValid = true;

        // Validate all fields
        for (const [fieldName] of validator.fields) {
            const isFieldValid = this.validateField(formId, fieldName);
            if (!isFieldValid) {
                isFormValid = false;
            }
        }

        validator.isValid = isFormValid;
        return isFormValid;
    }

    /**
     * Get form validation state
     * @param {string} formId - Form identifier
     * @returns {Object} Validation state
     */
    getFormState(formId) {
        const validator = this.validators.get(formId);
        if (!validator) return null;

        const fieldStates = {};
        for (const [fieldName, fieldData] of validator.fields) {
            fieldStates[fieldName] = {
                isValid: fieldData.isValid,
                errors: [...fieldData.errors]
            };
        }

        return {
            isValid: validator.isValid,
            fields: fieldStates
        };
    }

    /**
     * Clear validation state and UI
     * @param {string} formId - Form identifier
     */
    clearValidation(formId) {
        const validator = this.validators.get(formId);
        if (!validator) return;

        for (const [fieldName, fieldData] of validator.fields) {
            fieldData.isValid = false;
            fieldData.errors = [];
            this.clearFieldUI(fieldData.element);
        }

        validator.isValid = false;
    }

    /**
     * Clear validation for a specific field
     * @param {string} formId - Form identifier
     * @param {string} fieldName - Field name
     */
    clearFieldValidation(formId, fieldName) {
        const validator = this.validators.get(formId);
        if (!validator) return;

        const fieldData = validator.fields.get(fieldName);
        if (fieldData) {
            fieldData.isValid = false;
            fieldData.errors = [];
            this.clearFieldUI(fieldData.element);
        }
    }

    /**
     * Set up form event listeners
     * @private
     */
    setupFormListeners(formElement, config) {
        formElement.addEventListener('submit', (e) => {
            const formId = formElement.id;
            const isValid = this.validateForm(formId);
            
            if (!isValid) {
                e.preventDefault();
                this.focusFirstError(formId);
                return false;
            }
        });
    }

    /**
     * Set up field event listeners
     * @private
     */
    setupFieldListeners(field, formId, fieldName, config) {
        if (config.validateOnBlur) {
            field.addEventListener('blur', () => {
                this.validateField(formId, fieldName);
            });
        }

        if (config.validateOnInput) {
            field.addEventListener('input', () => {
                // Debounce input validation
                clearTimeout(field._validationTimeout);
                field._validationTimeout = setTimeout(() => {
                    this.validateField(formId, fieldName);
                }, 300);
            });
        }
        
        // Always validate file inputs on change
        if (field.type === 'file') {
            field.addEventListener('change', () => {
                // Don't validate if the field was programmatically cleared (no files selected)
                if (field.files.length === 0 && field.value === '') {
                    // This is likely a programmatic clear, don't show validation errors
                    this.clearFieldValidation(formId, fieldName);
                    return;
                }
                this.validateField(formId, fieldName);
            });
        }
    }

    /**
     * Run a single validation rule
     * @private
     */
    runValidationRule(rule, value, element) {
        const ruleName = typeof rule === 'string' ? rule : rule.rule;
        const ruleParams = typeof rule === 'object' ? rule.params : [];
        const customMessage = typeof rule === 'object' ? rule.message : null;

        const validator = this.validationRules[ruleName];
        if (!validator) {
            return { isValid: false, message: `Unknown validation rule: ${ruleName}` };
        }

        const isValid = validator.validate(value, ruleParams, element);
        const message = customMessage || this.messages[ruleName] || 'Invalid value';

        return {
            isValid,
            message: typeof message === 'function' ? message(ruleParams) : message
        };
    }

    /**
     * Update field UI based on validation state
     * @private
     */
    updateFieldUI(element, fieldData, config) {
        if (!config.highlightErrors && !config.showErrorMessages) return;

        // Clear existing state
        this.clearFieldUI(element);

        if (!fieldData.isValid && fieldData.errors.length > 0) {
            // Add error styling
            if (config.highlightErrors) {
                element.classList.add('form-error');
            }

            // Show error messages
            if (config.showErrorMessages) {
                this.showFieldErrors(element, fieldData.errors);
            }
        } else if (fieldData.isValid) {
            // Add success styling
            if (config.highlightErrors) {
                element.classList.add('form-success');
            }
        }
    }

    /**
     * Clear field UI state
     * @private
     */
    clearFieldUI(element) {
        element.classList.remove('form-error', 'form-success');
        
        // Remove existing error messages
        const existingErrors = element.parentNode.querySelectorAll('.error-message');
        existingErrors.forEach(error => error.remove());
    }

    /**
     * Show field error messages
     * @private
     */
    showFieldErrors(element, errors) {
        const errorContainer = document.createElement('div');
        errorContainer.className = 'error-message';
        errorContainer.textContent = errors[0]; // Show first error

        // Insert after the field
        element.parentNode.insertBefore(errorContainer, element.nextSibling);
    }

    /**
     * Focus first field with error
     * @private
     */
    focusFirstError(formId) {
        const validator = this.validators.get(formId);
        if (!validator) return;

        for (const [fieldName, fieldData] of validator.fields) {
            if (!fieldData.isValid) {
                fieldData.element.focus();
                break;
            }
        }
    }

    /**
     * Get field element by name or ID
     * @private
     */
    getFieldElement(form, fieldName) {
        return form.querySelector(`[name="${fieldName}"]`) || 
               form.querySelector(`#${fieldName}`) ||
               form.querySelector(fieldName);
    }

    /**
     * Get field value
     * @private
     */
    getFieldValue(element) {
        if (element.type === 'checkbox' || element.type === 'radio') {
            return element.checked;
        }
        if (element.type === 'file') {
            return element.files.length > 0 ? element.files : null;
        }
        return element.value.trim();
    }

    /**
     * Generate unique ID
     * @private
     */
    generateId() {
        return 'form_' + Math.random().toString(36).substr(2, 9);
    }

    /**
     * Get element from string or element
     * @private
     */
    getElement(element) {
        if (typeof element === 'string') {
            return document.getElementById(element) || document.querySelector(element);
        }
        return element instanceof HTMLElement ? element : null;
    }

    /**
     * Default validation rules
     * @private
     */
    getDefaultRules() {
        return {
            required: {
                validate: (value) => {
                    if (typeof value === 'boolean') return value;
                    if (value && value.length !== undefined) return value.length > 0; // Handle FileList
                    return value !== null && value !== undefined && value !== '';
                }
            },
            email: {
                validate: (value) => {
                    if (!value) return true; // Optional field
                    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                    return emailRegex.test(value);
                }
            },
            minLength: {
                validate: (value, params) => {
                    const minLength = params[0] || 0;
                    return value.length >= minLength;
                }
            },
            maxLength: {
                validate: (value, params) => {
                    const maxLength = params[0] || Infinity;
                    return value.length <= maxLength;
                }
            },
            fileSize: {
                validate: (value, params, element) => {
                    if (element.type !== 'file' || !element.files.length) return true;
                    const maxSize = params[0] || Infinity;
                    return element.files[0].size <= maxSize;
                }
            },
            fileType: {
                validate: (value, params, element) => {
                    if (element.type !== 'file' || !element.files.length) return true;
                    const allowedTypes = params || [];
                    const fileType = element.files[0].type;
                    const fileName = element.files[0].name.toLowerCase();
                    
                    return allowedTypes.some(type => {
                        if (type.includes('/')) {
                            return fileType === type;
                        } else {
                            return fileName.endsWith(type.toLowerCase());
                        }
                    });
                }
            }
        };
    }

    /**
     * Default error messages
     * @private
     */
    getDefaultMessages() {
        return {
            required: 'This field is required',
            email: 'Please enter a valid email address',
            minLength: (params) => `Minimum length is ${params[0]} characters`,
            maxLength: (params) => `Maximum length is ${params[0]} characters`,
            fileSize: (params) => `File size must be less than ${Math.round(params[0] / 1024 / 1024)}MB`,
            fileType: (params) => `Allowed file types: ${params.join(', ')}`
        };
    }
}

// Create global instance
window.formValidator = new FormValidator();

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = FormValidator;
} 