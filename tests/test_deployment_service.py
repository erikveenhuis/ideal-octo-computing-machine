"""Tests for ``services.deployment_service``.

The deployment flow shells out to ``git`` and ``pip`` and ``touch``. We mock
``subprocess.run`` at the module boundary so the tests stay hermetic and run
in <0.1s, but still exercise the orchestration logic, error handling and
fallback paths.
"""
from __future__ import annotations

import os
import subprocess
from unittest.mock import MagicMock

import pytest

from exceptions import GitOperationError, ServiceRestartError
from services.deployment_service import DeploymentService


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def service(app_context):
    """A DeploymentService with no configured WSGI / venv paths.

    The service captures ``current_app.logger`` at construction time, so we
    must build it inside an active app context.
    """
    return DeploymentService(wsgi_file_path=None, venv_pip_path=None)


@pytest.fixture
def configured_service(app_context):
    return DeploymentService(
        wsgi_file_path="/srv/wsgi.py",
        venv_pip_path="/opt/venv/bin/pip",
    )


def _completed_process(returncode: int = 0, stdout: str = "", stderr: str = ""):
    return subprocess.CompletedProcess(
        args=[], returncode=returncode, stdout=stdout, stderr=stderr,
    )


# ---------------------------------------------------------------------------
# start_deployment (background thread orchestrator)
# ---------------------------------------------------------------------------


class TestStartDeployment:
    def test_returns_immediately_and_starts_thread(self, service, mocker):
        # Block _deploy_process so we can assert the response is returned
        # before any real work happens.
        deploy_mock = mocker.patch.object(service, "_deploy_process")

        response = service.start_deployment({
            "repository": {"full_name": "user/repo"}
        })

        assert response == {
            "message": "Webhook received, starting deployment process",
            "status": "processing",
        }

        # The thread should have been kicked off and the target invoked.
        # Allow a short wait for the daemon thread to schedule.
        import time
        for _ in range(50):
            if deploy_mock.called:
                break
            time.sleep(0.01)
        assert deploy_mock.called

    def test_deploy_process_swallows_exceptions(self, service, mocker):
        """``_deploy_process`` must never raise out of the thread."""
        mocker.patch.object(
            service, "_ensure_git_repository", side_effect=RuntimeError("boom")
        )
        # Should not propagate the RuntimeError.
        service._deploy_process()


# ---------------------------------------------------------------------------
# _ensure_git_repository
# ---------------------------------------------------------------------------


class TestEnsureGitRepository:
    def test_finds_repo_in_current_dir(self, service, tmp_path, monkeypatch):
        (tmp_path / ".git").mkdir()
        monkeypatch.chdir(tmp_path)
        # Should return without raising or chdir-ing.
        service._ensure_git_repository()
        assert os.getcwd() == str(tmp_path)

    def test_walks_up_to_parent(self, service, tmp_path, monkeypatch):
        (tmp_path / ".git").mkdir()
        nested = tmp_path / "a" / "b" / "c"
        nested.mkdir(parents=True)
        monkeypatch.chdir(nested)
        service._ensure_git_repository()
        # Should have walked up until it found the .git directory.
        assert os.getcwd() == str(tmp_path)

    def test_raises_when_no_repo_found(self, service, tmp_path, monkeypatch):
        """Walk should reach the filesystem root and then raise.

        We patch ``os.path.exists`` to always say "no .git here" so we don't
        accidentally pick up a real .git on the host filesystem above
        ``tmp_path``. The walk must still terminate at ``/`` (the production
        code uses a previous-dir comparison to avoid an infinite loop).
        """
        nested = tmp_path / "deep"
        nested.mkdir()
        monkeypatch.chdir(nested)
        monkeypatch.setattr(os.path, "exists", lambda p: False)

        with pytest.raises(GitOperationError):
            service._ensure_git_repository()


# ---------------------------------------------------------------------------
# _update_code_from_git
# ---------------------------------------------------------------------------


class TestUpdateCodeFromGit:
    def test_runs_fetch_and_reset(self, service, mocker):
        mock_run = mocker.patch(
            "services.deployment_service.subprocess.run",
            return_value=_completed_process(stdout="HEAD is now at abc1234"),
        )
        service._update_code_from_git()

        # Two subprocess.run calls: fetch then reset.
        assert mock_run.call_count == 2
        first_args = mock_run.call_args_list[0].args[0]
        second_args = mock_run.call_args_list[1].args[0]
        assert first_args[:2] == ["git", "fetch"]
        assert second_args[:3] == ["git", "reset", "--hard"]

    def test_timeout_raises_git_operation_error(self, service, mocker):
        mocker.patch(
            "services.deployment_service.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="git", timeout=30),
        )
        with pytest.raises(GitOperationError):
            service._update_code_from_git()

    def test_failure_raises_git_operation_error(self, service, mocker):
        mocker.patch(
            "services.deployment_service.subprocess.run",
            side_effect=subprocess.CalledProcessError(
                returncode=1, cmd="git", stderr="fatal: nope",
            ),
        )
        with pytest.raises(GitOperationError):
            service._update_code_from_git()


# ---------------------------------------------------------------------------
# _install_dependencies
# ---------------------------------------------------------------------------


class TestInstallDependencies:
    def test_skips_when_no_requirements_file(self, service, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)  # No requirements.txt here.
        run_mock = monkeypatch.setattr(
            "services.deployment_service.subprocess.run",
            MagicMock(),
        )
        service._install_dependencies()
        # No subprocess call should have been made.
        import services.deployment_service as ds
        assert ds.subprocess.run.called is False

    def test_runs_pip_install(self, configured_service, tmp_path, monkeypatch, mocker):
        (tmp_path / "requirements.txt").write_text("flask\n")
        monkeypatch.chdir(tmp_path)
        # Pretend the configured pip path exists.
        monkeypatch.setattr(os.path, "exists", lambda p: True)

        mock_run = mocker.patch(
            "services.deployment_service.subprocess.run",
            return_value=_completed_process(stdout="Successfully installed"),
        )
        configured_service._install_dependencies()
        cmd = mock_run.call_args.args[0]
        assert cmd[0] == "/opt/venv/bin/pip"
        assert cmd[1:] == ["install", "-r", "requirements.txt"]

    def test_pip_failure_is_swallowed(self, service, tmp_path, monkeypatch, mocker):
        (tmp_path / "requirements.txt").write_text("flask\n")
        monkeypatch.chdir(tmp_path)
        mocker.patch(
            "services.deployment_service.subprocess.run",
            return_value=_completed_process(returncode=1, stderr="pip blew up"),
        )
        # Must not raise - dependency issues should not abort deployment.
        service._install_dependencies()

    def test_pip_timeout_is_swallowed(self, service, tmp_path, monkeypatch, mocker):
        (tmp_path / "requirements.txt").write_text("flask\n")
        monkeypatch.chdir(tmp_path)
        mocker.patch(
            "services.deployment_service.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="pip", timeout=300),
        )
        service._install_dependencies()


# ---------------------------------------------------------------------------
# _get_pip_executable
# ---------------------------------------------------------------------------


class TestGetPipExecutable:
    def test_uses_configured_path_when_present(self, configured_service, monkeypatch):
        monkeypatch.setattr(os.path, "exists", lambda p: p == "/opt/venv/bin/pip")
        assert configured_service._get_pip_executable() == "/opt/venv/bin/pip"

    def test_falls_back_to_system_pip_when_path_missing(
        self, configured_service, monkeypatch
    ):
        monkeypatch.setattr(os.path, "exists", lambda p: False)
        assert configured_service._get_pip_executable() == "pip"

    def test_falls_back_when_not_configured(self, service):
        # Default fixture has venv_pip_path=None.
        assert service._get_pip_executable() == "pip"


# ---------------------------------------------------------------------------
# _reload_application
# ---------------------------------------------------------------------------


class TestReloadApplication:
    def test_no_op_when_not_configured(self, service, mocker, monkeypatch):
        monkeypatch.setattr(os.path, "exists", lambda p: False)
        run_mock = mocker.patch("services.deployment_service.subprocess.run")
        service._reload_application()
        run_mock.assert_not_called()

    def test_no_op_when_wsgi_missing(self, configured_service, monkeypatch, mocker):
        monkeypatch.setattr(os.path, "exists", lambda p: False)
        run_mock = mocker.patch("services.deployment_service.subprocess.run")
        configured_service._reload_application()
        run_mock.assert_not_called()

    def test_touches_wsgi_twice(self, configured_service, monkeypatch, mocker):
        monkeypatch.setattr(os.path, "exists", lambda p: True)
        # Skip the real sleep between touches.
        mocker.patch("services.deployment_service.time.sleep")
        run_mock = mocker.patch(
            "services.deployment_service.subprocess.run",
            return_value=_completed_process(),
        )

        configured_service._reload_application()

        assert run_mock.call_count == 2
        for call in run_mock.call_args_list:
            assert call.args[0] == ["touch", "/srv/wsgi.py"]

    def test_touch_failure_raises_service_restart_error(
        self, configured_service, monkeypatch, mocker
    ):
        monkeypatch.setattr(os.path, "exists", lambda p: True)
        mocker.patch("services.deployment_service.time.sleep")
        mocker.patch(
            "services.deployment_service.subprocess.run",
            side_effect=subprocess.CalledProcessError(returncode=1, cmd="touch"),
        )
        with pytest.raises(ServiceRestartError):
            configured_service._reload_application()

    def test_touch_timeout_raises_service_restart_error(
        self, configured_service, monkeypatch, mocker
    ):
        monkeypatch.setattr(os.path, "exists", lambda p: True)
        mocker.patch("services.deployment_service.time.sleep")
        mocker.patch(
            "services.deployment_service.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="touch", timeout=10),
        )
        with pytest.raises(ServiceRestartError):
            configured_service._reload_application()

    def test_touches_inferred_pythonanywhere_wsgi(
        self, service, monkeypatch, mocker
    ):
        """Unset WSGI path: infer ``/var/www/<user>_pythonanywhere_com_wsgi.py``."""
        pa_wsgi = "/var/www/acme_pythonanywhere_com_wsgi.py"
        monkeypatch.setattr(os.path, "expanduser", lambda _: "/home/acme")

        def _exists(p):
            return str(p) == pa_wsgi

        monkeypatch.setattr(os.path, "exists", _exists)
        mocker.patch("services.deployment_service.time.sleep")
        run_mock = mocker.patch(
            "services.deployment_service.subprocess.run",
            return_value=_completed_process(),
        )

        service._reload_application()

        assert run_mock.call_count == 2
        for call in run_mock.call_args_list:
            assert call.args[0] == ["touch", pa_wsgi]
