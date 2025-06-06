# Code Quality Guidelines

This document outlines the code quality standards and tools used in this project.

## 🎯 Quality Standards

Our codebase maintains high quality standards with:
- **Pylint score**: Minimum 8.0/10.0
- **Code formatting**: Consistent style across all Python files
- **Type hints**: Added where beneficial
- **Documentation**: Clear docstrings for modules, classes, and functions
- **Error handling**: Proper exception handling with custom exception classes

## 🛠️ Tools Used

### Primary Tools
- **Pylint**: Code analysis and quality scoring
- **GitHub Actions**: Automated CI/CD pipeline for quality checks
- **Custom Scripts**: Local quality checking tools

### Development Tools (Optional)
- **Black**: Code formatting
- **isort**: Import sorting
- **mypy**: Static type checking
- **pytest**: Unit testing framework

## 🚀 Quick Start

### Run Quality Checks Locally

```bash
# Quick check
./scripts/quality_check.sh

# Or run pylint directly
pylint $(find . -name "*.py" -not -path "./.venv/*") --fail-under=8.0
```

### Install Development Dependencies

```bash
# Install all development tools
pip install -r requirements-dev.txt

# Or just install pylint
pip install pylint
```

## 🔧 Configuration

### Pylint Configuration
Our pylint configuration (`.pylintrc`) is customized for this Flask application:

**Disabled Checks** (too strict for our use case):
- `import-error`: Dependencies might not be available in CI
- `too-many-arguments`: Services often need multiple parameters
- `broad-exception-caught`: Acceptable for API services
- `trailing-whitespace`: Handled automatically

**Custom Limits**:
- Maximum line length: 100 characters
- Maximum arguments: 7
- Maximum local variables: 20
- Minimum pylint score: 8.0

### GitHub Actions
Quality checks run automatically on:
- Push to `main` or `develop` branches
- Pull requests to `main` or `develop` branches
- Multiple Python versions (3.11, 3.12, 3.13)

## 📋 Quality Checklist

Before committing code, ensure:

- [ ] **Pylint score ≥ 8.0**: Run `./scripts/quality_check.sh`
- [ ] **No trailing whitespace**: Automatically cleaned by our tools
- [ ] **Proper imports**: Flask/external imports at the top
- [ ] **Docstrings**: Added for new functions/classes
- [ ] **Error handling**: Uses our custom exception classes
- [ ] **Type hints**: Added for new functions (where beneficial)
- [ ] **Constants**: Magic numbers replaced with named constants

## 🔍 Common Issues and Fixes

### Import Errors in CI/CD
**Issue**: `E0401: Unable to import 'flask'`
**Fix**: Dependencies are installed in CI, these errors are disabled in our config.

### Trailing Whitespace
**Issue**: `C0303: Trailing whitespace`
**Fix**: Run our quality script which automatically removes trailing whitespace.

### Too Many Arguments
**Issue**: `R0913: Too many arguments`
**Solution**: 
1. Use configuration objects
2. Group related parameters
3. Consider if the function is doing too much

### Long Lines
**Issue**: `C0301: Line too long`
**Fix**: Break long lines at logical points (after commas, before operators).

### Missing Docstrings
**Issue**: `C0111: Missing function docstring`
**Fix**: Add descriptive docstrings with Args, Returns, and Raises sections.

## 📈 Improving Code Quality

### 1. Gradual Improvement
- Start with fixing high-impact issues
- Focus on one module at a time
- Aim for incremental score improvements

### 2. Best Practices
- **Single Responsibility**: Each function should have one clear purpose
- **Clear Naming**: Use descriptive variable and function names
- **Error Handling**: Use specific exception types
- **Documentation**: Keep docstrings up to date

### 3. Monitoring
- Check pylint score regularly
- Monitor CI/CD pipeline status
- Review quality metrics in pull requests

## 🚫 Bypassing Quality Checks

In rare cases, you might need to disable specific pylint warnings:

```python
# Disable for a single line
result = some_function()  # pylint: disable=some-warning

# Disable for a block
# pylint: disable=broad-exception-caught
try:
    risky_operation()
except Exception as e:
    handle_any_error(e)
# pylint: enable=broad-exception-caught
```

**Use sparingly** and always document why the check is disabled.

## 📊 Quality Metrics

Current project status:
- **Overall Pylint Score**: 10.0/10.0 ✅
- **Files Analyzed**: 11 Python files
- **CI/CD Status**: Passing ✅
- **Code Coverage**: Not yet implemented
- **Security Scan**: Not yet implemented

## 🛣️ Future Improvements

Planned quality enhancements:
1. **Add unit tests** with pytest and coverage reporting
2. **Implement pre-commit hooks** for automatic quality checks
3. **Add security scanning** with bandit
4. **Integrate type checking** with mypy
5. **Add dependency vulnerability scanning** with safety

## 📞 Getting Help

- **Local Issues**: Run `./scripts/quality_check.sh` for detailed output
- **CI/CD Issues**: Check GitHub Actions logs
- **Configuration Questions**: Review `.pylintrc` file
- **Best Practices**: Follow the examples in existing service modules

---

Remember: Quality tools are here to help, not hinder. They catch issues early and maintain consistency across the codebase. If you encounter persistent issues, consider if the code needs refactoring rather than disabling warnings. 