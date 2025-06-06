"""
Deployment service for handling GitHub webhook deployments.

This service manages the deployment process including:
- Git operations (fetch, reset)
- Dependency management
- Process reloading
- Background job management
"""
import os
import subprocess
import threading
import time
from typing import Dict, Any, Optional
from flask import current_app

from exceptions import GitOperationError, DependencyInstallError, ServiceRestartError


class DeploymentService:
    """Service for handling deployment operations."""

    def __init__(self,
                 wsgi_file_path: Optional[str] = None,
                 venv_pip_path: Optional[str] = None):
        """
        Initialize the deployment service.

        Args:
            wsgi_file_path: Path to the WSGI file for reloading
            venv_pip_path: Path to the virtual environment pip executable
        """
        self.wsgi_file_path = wsgi_file_path
        self.venv_pip_path = venv_pip_path
        self.logger = current_app.logger if current_app else None

    def start_deployment(self, payload: Dict[str, Any]) -> Dict[str, str]:
        """
        Start the deployment process in a background thread.

        Args:
            payload: GitHub webhook payload

        Returns:
            Response dictionary with deployment status
        """
        if self.logger:
            repository_name = payload.get('repository', {}).get('full_name', 'unknown')
            self.logger.info(f"Starting deployment for repository: {repository_name}")

        # Start the deployment process in a background thread
        thread = threading.Thread(target=self._deploy_process)
        thread.daemon = True
        thread.start()

        return {
            'message': 'Webhook received, starting deployment process',
            'status': 'processing'
        }

    def _deploy_process(self) -> None:
        """Execute the deployment process with proper error handling."""
        try:
            self._log_info("Starting deployment process...")

            # Step 1: Ensure we're in the correct directory
            self._ensure_git_repository()

            # Step 2: Update code from repository
            self._update_code_from_git()

            # Step 3: Install/update dependencies
            self._install_dependencies()

            # Step 4: Reload the application
            self._reload_application()

            self._log_info("Deployment completed successfully")

        except Exception as e:
            self._log_error(f"Deployment failed: {str(e)}")
            import traceback
            self._log_error(f"Deployment traceback: {traceback.format_exc()}")

    def _ensure_git_repository(self) -> None:
        """Ensure we're in a git repository directory."""
        current_dir = os.getcwd()
        self._log_info(f"Current working directory: {current_dir}")

        if os.path.exists(os.path.join(current_dir, '.git')):
            self._log_info("Found git repository in current directory")
            return

        # Search for git repository in parent directories
        self._log_info("Not in a git repository, searching parent directories...")
        parent_dir = os.path.dirname(current_dir)

        while parent_dir != current_dir:
            if os.path.exists(os.path.join(parent_dir, '.git')):
                self._log_info(f"Found git repository in: {parent_dir}")
                os.chdir(parent_dir)
                return
            parent_dir = os.path.dirname(parent_dir)

        raise GitOperationError("Could not find git repository", repository_path=os.getcwd())

    def _update_code_from_git(self) -> None:
        """Update code from the git repository."""
        self._log_info("Fetching latest changes from git...")

        try:
            # Fetch all changes
            result = subprocess.run(
                ['git', 'fetch', '--all'],
                check=True,
                capture_output=True,
                text=True,
                timeout=30
            )
            self._log_info("Git fetch completed successfully")

            # Reset to origin/main
            result = subprocess.run(
                ['git', 'reset', '--hard', 'origin/main'],
                check=True,
                capture_output=True,
                text=True,
                timeout=30
            )
            self._log_info("Git reset completed successfully")

            if result.stdout:
                self._log_info(f"Git reset output: {result.stdout.strip()}")

        except subprocess.TimeoutExpired as e:
            raise GitOperationError(f"Git operation timed out: {str(e)}", git_command="fetch/reset")
        except subprocess.CalledProcessError as e:
            raise GitOperationError(f"Git operation failed: {e.stderr}", git_command="fetch/reset")

    def _install_dependencies(self) -> None:
        """Install or update Python dependencies."""
        if not os.path.exists('requirements.txt'):
            self._log_info("No requirements.txt found, skipping dependency installation")
            return

        self._log_info("Installing/updating dependencies...")

        # Determine which pip to use
        pip_executable = self._get_pip_executable()
        self._log_info(f"Using pip executable: {pip_executable}")

        try:
            result = subprocess.run(
                [pip_executable, 'install', '-r', 'requirements.txt'],
                capture_output=True,
                text=True,
                timeout=300  # 5 minute timeout for pip install
            )

            if result.returncode == 0:
                self._log_info("Dependencies installed successfully")
                if result.stdout:
                    self._log_info(f"Pip install output: {result.stdout}")
            else:
                # Log but don't fail deployment for pip issues
                self._log_error(f"Pip install failed (continuing anyway): {result.stderr}")
                if result.stdout:
                    self._log_error(f"Pip install stdout: {result.stdout}")

        except subprocess.TimeoutExpired:
            self._log_error("Pip install timed out (continuing anyway)")
            # Don't raise exception - dependency issues shouldn't stop deployment
        except Exception as e:
            self._log_error(f"Pip install error (continuing anyway): {str(e)}")
            # Don't raise exception - dependency issues shouldn't stop deployment

    def _get_pip_executable(self) -> str:
        """Determine the correct pip executable to use."""
        # Check if virtual environment pip exists
        if os.path.exists(self.venv_pip_path):
            return self.venv_pip_path

        self._log_info(f"Virtual environment pip not found at {self.venv_pip_path}")
        self._log_info("Falling back to system pip")
        return 'pip'

    def _reload_application(self) -> None:
        """Reload the WSGI application."""
        if not os.path.exists(self.wsgi_file_path):
            self._log_error(f"WSGI file not found at: {self.wsgi_file_path}")
            return

        try:
            # First touch to trigger reload
            subprocess.run(['touch', self.wsgi_file_path], check=True, timeout=10)
            self._log_info("Successfully touched WSGI file")

            # Wait for old workers to start shutting down
            time.sleep(2)

            # Touch again to ensure new workers start
            subprocess.run(['touch', self.wsgi_file_path], check=True, timeout=10)
            self._log_info("Touched WSGI file again to ensure new workers start")

        except subprocess.CalledProcessError as e:
            raise ServiceRestartError(f"Failed to reload WSGI application: {str(e)}",
                                     service_name="WSGI", restart_method="touch")
        except subprocess.TimeoutExpired:
            raise ServiceRestartError("WSGI reload operation timed out",
                                     service_name="WSGI", restart_method="touch")

    def _log_info(self, message: str) -> None:
        """Log info message."""
        if self.logger:
            self.logger.info(message)
        else:
            print(f"INFO: {message}")

    def _log_error(self, message: str) -> None:
        """Log error message."""
        if self.logger:
            self.logger.error(message)
        else:
            print(f"ERROR: {message}")
