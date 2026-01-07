"""Docker management for SWE-bench instance containers."""

import base64
import json
import os
import shlex
import shutil
import tarfile
import time
import uuid
import re
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import docker
import structlog
from jinja2 import StrictUndefined, Template
from docker.errors import APIError, DockerException, ImageNotFound

from costrict_swebench.domain.models import SWEInstance
from costrict_swebench.infra.data_loader import resolve_image_name

logger = structlog.get_logger()


def _parse_repo_tag(image: str) -> Tuple[str, str]:
    name = image
    if name.startswith("docker.io/"):
        name = name[len("docker.io/") :]
    if ":" not in name:
        return name, "latest"
    before, after = name.rsplit(":", 1)
    if "/" in after:
        return name, "latest"
    return before, after or "latest"


class DockerManager:
    """Manages Docker containers for SWE-bench evaluation."""
    
    def __init__(self):
        try:
            http_timeout = int(os.environ.get("COSTRICT_DOCKER_HTTP_TIMEOUT", "21600"))
            self.client = docker.from_env(timeout=http_timeout)
            self.client.ping()
        except DockerException as e:
            docker_host = os.environ.get("DOCKER_HOST")
            raise RuntimeError(
                "Cannot connect to Docker daemon. Ensure Docker Desktop (or other Docker engine) is running, "
                "and DOCKER_HOST is correctly set. On macOS Docker Desktop typically uses a unix socket under "
                "/var/run/docker.sock. "
                f"DOCKER_HOST={docker_host!r}. Original error: {e}"
            )
        
    def pull_image(self, image_name: str) -> None:
        """Pull a Docker image if not present."""
        try:
            self.client.images.get(image_name)
            logger.info("Image already exists locally", image_name=image_name)
        except ImageNotFound:
            logger.info("Pulling Docker image", image_name=image_name)
            last_error: Exception | None = None
            for attempt in range(1, 4):
                try:
                    verbose_progress = True
                    repo, tag = _parse_repo_tag(image_name)

                    last_by_layer: Dict[str, Tuple[str, str]] = {}
                    for event in self.client.api.pull(repo, tag=tag, stream=True, decode=True):
                        if not isinstance(event, dict):
                            continue

                        if "error" in event and event.get("error"):
                            raise RuntimeError(str(event.get("error")))

                        status = str(event.get("status") or "")
                        layer_id = str(event.get("id") or "")
                        progress = str(event.get("progress") or "")

                        if not status:
                            continue

                        if layer_id:
                            key = layer_id
                            value = (status, progress if verbose_progress else "")
                            if last_by_layer.get(key) == value:
                                continue
                            last_by_layer[key] = value
                            if verbose_progress and progress:
                                logger.info(
                                    "Docker pull progress",
                                    image_name=image_name,
                                    layer_id=layer_id,
                                    status=status,
                                    progress=progress,
                                )
                            else:
                                logger.info(
                                    "Docker pull progress",
                                    image_name=image_name,
                                    layer_id=layer_id,
                                    status=status,
                                )
                        else:
                            logger.info(
                                "Docker pull status",
                                image_name=image_name,
                                status=status,
                            )

                    return
                except (APIError, DockerException, RuntimeError) as e:
                    last_error = e
                    logger.warning(
                        "Docker image pull failed",
                        image_name=image_name,
                        attempt=attempt,
                        max_attempts=3,
                        error=str(e),
                    )
                    if attempt < 3:
                        time.sleep(2**attempt)
            raise RuntimeError(
                f"Failed to pull Docker image after 3 attempts: {image_name}. "
                f"This is often caused by network/proxy/Docker Hub connectivity issues. "
                f"Last error: {last_error}"
            )
            
    def create_workspace_volume(self, *, prefix: str = "costrict-swebench-ws") -> str:
        """Create a per-instance Docker named volume for sharing workspace between containers."""
        volume_name = f"{prefix}-{uuid.uuid4().hex[:12]}"
        self.client.volumes.create(name=volume_name)
        return volume_name

    def remove_volume(self, volume_name: str) -> None:
        try:
            vol = self.client.volumes.get(volume_name)
            vol.remove(force=True)
        except Exception as e:
            logger.warning("Failed to remove docker volume", volume_name=volume_name, error=str(e))

    def remove_image(self, image_name: str, force: bool = False) -> None:
        """Remove a Docker image.
        
        Args:
            image_name: Name of the image to remove
            force: If True, force remove even if image is in use
        """
        try:
            image = self.client.images.get(image_name)
            self.client.images.remove(image.id, force=force)
            logger.info("Removed Docker image", image_name=image_name)
        except ImageNotFound:
            logger.debug("Image not found, skipping removal", image_name=image_name)
        except APIError as e:
            # Image might be in use by other containers
            if "image is being used" in str(e).lower() or "is being used by" in str(e).lower():
                logger.debug(
                    "Image is in use, skipping removal",
                    image_name=image_name,
                    error=str(e),
                )
            else:
                logger.warning(
                    "Failed to remove Docker image",
                    image_name=image_name,
                    error=str(e),
                )
        except Exception as e:
            logger.warning(
                "Failed to remove Docker image",
                image_name=image_name,
                error=str(e),
            )

    def write_text_file_in_container(
        self,
        *,
        container: Any,
        path: str,
        content: str,
        mode: str = "0644",
    ) -> None:
        """Write text content into the container without hitting shell ARG_MAX limits."""
        normalized = content.replace("\r\n", "\n").encode("utf-8", errors="replace")

        dir_path, file_name = os.path.split(path)
        dir_path = dir_path or "."
        file_name = file_name or "tmpfile"
        file_mode = int(mode, 8) if isinstance(mode, str) else int(mode)

        mkdir_cmd = f"mkdir -p {shlex.quote(dir_path)}"
        mkdir_result = container.exec_run(["bash", "-lc", mkdir_cmd], demux=True)
        if int(mkdir_result.exit_code) != 0:
            stdout_b, stderr_b = mkdir_result.output if mkdir_result.output else (b"", b"")
            stderr = stderr_b.decode(errors="replace") if stderr_b else ""
            raise RuntimeError(f"Failed ensuring directory in container: {dir_path}. stderr={stderr}")

        tar_stream = BytesIO()
        with tarfile.open(fileobj=tar_stream, mode="w") as tar:
            info = tarfile.TarInfo(name=file_name)
            info.size = len(normalized)
            info.mode = file_mode
            tar.addfile(info, BytesIO(normalized))
        tar_stream.seek(0)

        success = container.put_archive(dir_path, tar_stream.getvalue())
        if not success:
            raise RuntimeError(f"Failed writing file in container: {path}. put_archive returned false")

    def read_text_file_in_container(
        self,
        *,
        container: Any,
        path: str,
        max_bytes: int = 2_000_000,
    ) -> Tuple[int, str, str]:
        cmd = (
            "set -euo pipefail; "
            f"if [ -f {shlex.quote(path)} ]; then "
            f"tail -c {int(max_bytes)} {shlex.quote(path)}; "
            "else echo '__COSTRICT_NOFILE__' 1>&2; exit 2; fi"
        )
        result = container.exec_run(["bash", "-lc", cmd], demux=True)
        stdout_b, stderr_b = result.output if result.output else (b"", b"")
        stdout = stdout_b.decode(errors="replace") if stdout_b else ""
        stderr = stderr_b.decode(errors="replace") if stderr_b else ""
        return int(result.exit_code), stdout, stderr

    def copy_repo_to_workspace(
        self,
        *,
        container: Any,
        src_repo_dir: str,
        dst_repo_dir: str,
    ) -> Tuple[int, str, str]:
        """Copy repo content to a shared workspace path inside the same container.

        This avoids host filesystem usage and enables a named volume to be shared with a runner container.
        """
        cmd = (
            "set -euo pipefail; "
            f"rm -rf {dst_repo_dir}; mkdir -p {dst_repo_dir}; "
            f"tar -C {src_repo_dir} -cf - . | tar -C {dst_repo_dir} -xf -; "
            f"test -d {dst_repo_dir}/.git; "
            f"cd {dst_repo_dir}; git rev-parse HEAD; git status --porcelain=v1 || true"
        )
        result = container.exec_run(["bash", "-lc", cmd], demux=True)
        stdout_b, stderr_b = result.output if result.output else (b"", b"")
        stdout = stdout_b.decode(errors="replace") if stdout_b else ""
        stderr = stderr_b.decode(errors="replace") if stderr_b else ""
        return int(result.exit_code), stdout, stderr

    def create_instance_container(
        self,
        instance: SWEInstance,
        workspace_host: Optional[Path] = None,
        workspace_volume: Optional[str] = None,
        workspace_container: str = "/workspace",
        workdir: str = "/testbed",
        user: str = "root",
        container_timeout: int = 6 * 60 * 60,
    ) -> Any:
        """Create and start a SWE-bench instance container.

        By default, this follows the SWE-bench harness convention: the repo and environment
        are pre-baked into the image under /testbed (or /testbed/repo). We therefore prefer
        not to clone and not to rely on host mounts.
        """
        image_name = resolve_image_name(instance)

        if workspace_host is not None and workspace_volume is not None:
            raise ValueError("workspace_host and workspace_volume are mutually exclusive")

        volumes = None
        if workspace_host is not None:
            workspace_host.mkdir(parents=True, exist_ok=True)
            volumes = {
                str(workspace_host): {
                    "bind": workspace_container,
                    "mode": "rw",
                }
            }
        elif workspace_volume is not None:
            volumes = {
                workspace_volume: {
                    "bind": workspace_container,
                    "mode": "rw",
                }
            }
        
        # Pull image if needed
        self.pull_image(image_name)
        
        # Create container
        container_name = f"costrict-swebench-{uuid.uuid4().hex[:8]}"
        container = self.client.containers.run(
            image_name,
            detach=True,
            remove=False,
            name=container_name,
            working_dir=workdir,
            user=user,
            volumes=volumes,
            # Enable host.docker.internal on Linux (already works on macOS/Windows Docker Desktop)
            extra_hosts={"host.docker.internal": "host-gateway"},
            command=["bash", "-lc", f"sleep {container_timeout}"],
        )
        
        logger.info(
            "Created instance container",
            instance_id=instance.instance_id,
            container_id=container.id,
            image_name=image_name,
        )
        
        return container

    def run_costrict_swe_task_in_runner_container(
        self,
        *,
        volume_name: str,
        instance_container_ref: Optional[str] = None,
        container_workdir: str = "/workspace/repo",
        host_vsix_path: Optional[str] = None,
        progress_log_path: Optional[str] = None,
        instance_id: str,
        workspace_path: str,
        prompt_file_path: str,
        timeout_seconds: int,
        include_timeout_ms: bool = True,
        runner_image: str = "costrict-evals-runner:dev",
        mode: str = "swebench",
        zgsm_code_mode: str = "vibe",
        api_provider: str = "zgsm",
    ) -> Dict[str, object]:
        """Run a SWE task using the costrict-evals-runner container and return {patch, trajectory}.

        The runner container starts headless VS Code (xvfb) and communicates with the extension via IPC.
        It prints a structured marker to stdout: __COSTRICT_RESULT__<json>.
        """
        env = {
            "HOST_EXECUTION_METHOD": "docker",
        }
        env["TMPDIR"] = "/workspace/tmp"
        env["TMP"] = "/workspace/tmp"
        env["TEMP"] = "/workspace/tmp"
        if instance_container_ref:
            env["ROO_CODE_SWE_INSTANCE_CONTAINER"] = instance_container_ref
            env["ROO_CODE_SWE_CONTAINER_WORKDIR"] = container_workdir
        for k in ["OPENROUTER_API_KEY", "ROO_CODE_CLOUD_TOKEN", "ZAI_API_KEY"]:
            if os.environ.get(k):
                env[k] = os.environ[k]

        self.pull_image(runner_image)

        volumes = {
            volume_name: {
                "bind": "/workspace",
                "mode": "rw",
            },
            "/var/run/docker.sock": {
                "bind": "/var/run/docker.sock",
                "mode": "rw",
            },
        }

        host_costrict_share = str(Path.home() / ".costrict" / "share")
        if os.path.isdir(host_costrict_share):
            volumes[host_costrict_share] = {
                "bind": "/roo/.costrict/share",
                "mode": "ro",
            }

        if host_vsix_path:
            volumes[host_vsix_path] = {
                "bind": "/tmp/roo-code.vsix",
                "mode": "ro",
            }

        install_vsix_cmd = ""
        if host_vsix_path:
            install_vsix_cmd = (
                "if [ -f /tmp/roo-code.vsix ]; then "
                "yes | code --no-sandbox --user-data-dir /roo/.vscode --install-extension /tmp/roo-code.vsix --force; "
                "fi; "
            )

        cmd = (
            "mkdir -p /workspace/tmp; "
            + install_vsix_cmd
            + "pnpm --filter @roo-code/evals cli "
            + f"--instance-id {shlex.quote(instance_id)} "
            + f"--workspace-path {shlex.quote(workspace_path)} "
            + f"--prompt-file {shlex.quote(prompt_file_path)} "
            + f"--mode {shlex.quote(mode)} "
            + f"--api-provider {shlex.quote(api_provider)} "
            + f"--zgsm-code-mode {shlex.quote(zgsm_code_mode)}"
        )

        if include_timeout_ms:
            cmd = cmd + f" --timeout-ms {int(timeout_seconds * 2 * 1000)}"

        safe_instance = re.sub(r"[^a-zA-Z0-9_.-]+", "-", instance_id)[:80]
        container_name = f"costrict-evals-runner-{safe_instance}-{uuid.uuid4().hex[:8]}"
        container = self.client.containers.run(
            runner_image,
            detach=True,
            remove=False,
            name=container_name,
            working_dir="/roo/repo",
            environment=env,
            volumes=volumes,
            command=["bash", "-lc", cmd],
        )

        try:
            start_ts = time.time()
            initial_deadline = start_ts + float(timeout_seconds)
            max_deadline = start_ts + float(timeout_seconds) * 2.0
            renewal_grace_seconds = 3 * 60
            early_stall_check_ts = start_ts + float(timeout_seconds) * 0.5
            deadline = initial_deadline
            marker = "__COSTRICT_RESULT__"
            runner_stdout_tail = ""
            payload_line: str | None = None
            last_tool_ts: int = 0
            last_messages_bytes_by_filename: Dict[str, int] = {}

            while True:
                if progress_log_path:
                    try:
                        last_tool_ts = self._append_agent_tool_calls_from_workspace_tmp(
                            runner_container=container,
                            instance_id=instance_id,
                            progress_log_path=progress_log_path,
                            last_tool_ts=last_tool_ts,
                        )
                    except Exception:
                        pass

                    try:
                        instance_dir = os.path.dirname(progress_log_path)
                        last_messages_bytes_by_filename = self._sync_costrict_messages_log_from_workspace_tmp(
                            runner_container=container,
                            instance_id=instance_id,
                            instance_dir=instance_dir,
                            last_bytes_by_filename=last_messages_bytes_by_filename,
                        )
                    except Exception:
                        pass

                logs = container.logs(stdout=True, stderr=True, tail=20000)
                text = logs.decode(errors="replace") if isinstance(logs, (bytes, bytearray)) else str(logs)
                runner_stdout_tail = text[-200_000:] if len(text) > 200_000 else text

                # Capture state machine logs from container output
                if progress_log_path:
                    try:
                        self._capture_state_machine_logs(text, progress_log_path)
                    except Exception:
                        pass

                idx = text.rfind(marker)
                if idx != -1:
                    payload_line = text[idx + len(marker) :].splitlines()[0].strip()
                    break

                container.reload()
                state = getattr(container, "attrs", {}).get("State", {}) if hasattr(container, "attrs") else {}
                status = str(state.get("Status") or "")
                if status in {"exited", "dead"}:
                    status_code = int(state.get("ExitCode", 1) or 1)
                    raise RuntimeError(
                        f"Runner container exited without structured result marker. exit_code={status_code}. "
                        f"tail={text[-2000:]}"
                    )

                if time.time() >= early_stall_check_ts and progress_log_path:
                    instance_dir = os.path.dirname(progress_log_path)
                    if self._has_messages_log(instance_dir=instance_dir, instance_id=instance_id) and not self._is_messages_log_recent(
                        instance_dir=instance_dir,
                        instance_id=instance_id,
                        stale_after_seconds=float(renewal_grace_seconds),
                    ):
                        raise TimeoutError(
                            f"Runner container stalled: messages log not updated within {renewal_grace_seconds}s. "
                            f"timeout_seconds={timeout_seconds} container_name={container_name}. "
                            f"tail={runner_stdout_tail[-2000:]}"
                        )

                if time.time() >= deadline:
                    now = time.time()
                    if now < max_deadline and progress_log_path:
                        instance_dir = os.path.dirname(progress_log_path)
                        if self._is_messages_log_recent(
                            instance_dir=instance_dir,
                            instance_id=instance_id,
                            stale_after_seconds=float(renewal_grace_seconds),
                        ):
                            new_deadline = min(deadline + float(renewal_grace_seconds), max_deadline)
                            if new_deadline > deadline:
                                logger.info(
                                    "Extending runner timeout based on recent messages log activity",
                                    instance_id=instance_id,
                                    container_name=container_name,
                                    old_deadline_seconds_from_start=deadline - start_ts,
                                    new_deadline_seconds_from_start=new_deadline - start_ts,
                                    max_deadline_seconds_from_start=max_deadline - start_ts,
                                )
                                deadline = new_deadline
                            else:
                                raise TimeoutError(
                                    f"Runner container reached max timeout cap (2x). "
                                    f"timeout_seconds={timeout_seconds} container_name={container_name}. "
                                    f"tail={runner_stdout_tail[-2000:]}"
                                )
                        else:
                            raise TimeoutError(
                                f"Runner container stalled: messages log not updated within {renewal_grace_seconds}s. "
                                f"timeout_seconds={timeout_seconds} container_name={container_name}. "
                                f"tail={runner_stdout_tail[-2000:]}"
                            )
                    else:
                        raise TimeoutError(
                            f"Runner container did not produce structured result within timeout_seconds={timeout_seconds}. "
                            f"container_name={container_name}. tail={runner_stdout_tail[-2000:]}"
                        )

                time.sleep(2)

            if payload_line is None:
                raise RuntimeError(
                    f"Runner output did not include structured result marker. tail={runner_stdout_tail[-2000:]}"
                )
            try:
                parsed = json.loads(payload_line)
            except Exception as e:
                raise RuntimeError(
                    f"Failed to parse runner structured JSON payload: {e}. payload={payload_line[:500]}"
                )

            patch = parsed.get("patch") if isinstance(parsed, dict) else None
            if not isinstance(patch, str):
                patch = ""
            trajectory = parsed.get("trajectory") if isinstance(parsed, dict) else None

            return {
                "patch": patch,
                "trajectory": trajectory,
                "runner_container_name": container_name,
                "runner_stdout_tail": runner_stdout_tail,
            }
        finally:
            keep = str(os.environ.get("COSTRICT_KEEP_RUNNER_CONTAINER", "")).strip().lower() in {"1", "true", "yes"}
            if not keep:
                try:
                    container.remove(force=True)
                except Exception as e:
                    logger.warning(
                        "Failed to remove runner container",
                        error=str(e),
                        container_id=getattr(container, "id", None),
                    )

    def _safe_json_parse(self, text: str) -> Optional[Dict]:
        """Safely parse JSON with error handling."""
        try:
            return json.loads(text)
        except Exception:
            # Fall back to raw_decode to tolerate trailing content (e.g. when parsing
            # tail -c output that may include extra bytes after a JSON object).
            try:
                decoder = json.JSONDecoder()
                s = text.lstrip()
                if not s:
                    return None
                obj, _end = decoder.raw_decode(s)
                return obj if isinstance(obj, dict) else None
            except Exception as e:
                logger.warning("JSON parse failed", error=str(e), text=text[:100])
                return None

    def _is_messages_log_recent(
        self,
        *,
        instance_dir: str,
        instance_id: str,
        stale_after_seconds: float,
    ) -> bool:
        try:
            if not instance_dir:
                return False
            d = Path(instance_dir)
            if not d.exists():
                return False

            pattern = f"costrict-messages-{instance_id}-*.log"
            candidates = list(d.glob(pattern))
            if not candidates:
                return False

            newest = max(candidates, key=lambda p: p.stat().st_mtime)
            age = time.time() - float(newest.stat().st_mtime)
            return age <= float(stale_after_seconds)
        except Exception:
            return False

    def _has_messages_log(self, *, instance_dir: str, instance_id: str) -> bool:
        try:
            if not instance_dir:
                return False
            d = Path(instance_dir)
            if not d.exists():
                return False
            pattern = f"costrict-messages-{instance_id}-*.log"
            for _p in d.glob(pattern):
                return True
            return False
        except Exception:
            return False

    def _format_log_entry(self, category: str, details: str) -> str:
        """Format a standardized log entry with ISO timestamp."""
        from datetime import datetime, timezone
        timestamp = datetime.now(timezone.utc).isoformat()
        return f"[{timestamp}] [{category}] {details}\n"

    def _safe_file_write(self, path: str, content: str) -> bool:
        """Safely write to file with error handling."""
        try:
            # Ensure directory exists
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "a", encoding="utf-8", errors="replace") as f:
                f.write(content)
            return True
        except Exception as e:
            logger.warning("File write failed", path=path, error=str(e))
            return False

    def _capture_state_machine_logs(self, container_logs: str, progress_log_path: str) -> None:
        """Capture state machine logs from container output."""
        try:
            # Look for [SWEBench] prefixed logs in container output
            lines = container_logs.split('\n')
            for line in lines:
                if '[SWEBench]' in line:
                    # Extract the state machine log content
                    # Format: [SWEBench] Phase transition: ANALYZE -> MODIFY
                    # Format: [SWEBench] Tool blocked: apply_diff - reason
                    match = re.search(r'\[SWEBench\]\s*(.+)', line)
                    if match:
                        state_event = match.group(1).strip()
                        log_entry = self._format_log_entry("STATE_MACHINE", state_event)
                        self._safe_file_write(progress_log_path, log_entry)
        except Exception as e:
            logger.warning("Failed to capture state machine logs", error=str(e))

    def _append_agent_tool_calls_from_workspace_tmp(
        self,
        *,
        runner_container: Any,
        instance_id: str,
        progress_log_path: str,
        last_tool_ts: int,
        max_bytes: int = 200_000,
    ) -> int:
        list_cmd = (
            "ls -1 /workspace/tmp 2>/dev/null | "
            + f"grep -E '^costrict-messages-{re.escape(instance_id)}-' || true"
        )
        res = runner_container.exec_run(["bash", "-lc", list_cmd], demux=True)
        stdout_b, _stderr_b = res.output if res.output else (b"", b"")
        listing = stdout_b.decode(errors="replace") if stdout_b else ""
        files = [line.strip() for line in listing.splitlines() if line.strip()]
        if not files:
            return last_tool_ts

        filename = files[-1]
        path = f"/workspace/tmp/{filename}"
        read_cmd = f"tail -c {int(max_bytes)} {shlex.quote(path)} 2>/dev/null || true"
        res2 = runner_container.exec_run(["bash", "-lc", read_cmd], demux=True)
        stdout_b2, _stderr_b2 = res2.output if res2.output else (b"", b"")
        text = stdout_b2.decode(errors="replace") if stdout_b2 else ""
        if not text:
            return last_tool_ts

        # tail -c can start in the middle of a record. In that case, the first split chunk
        # is not a valid "[timestamp] { ... }" entry and can trigger noisy JSON parse warnings.
        if not text.startswith("["):
            first = text.find("\n[")
            if first != -1:
                text = text[first + 1 :]

        chunks = re.split(r"(?m)^\[", text)
        for c in chunks:
            c = c.strip()
            if not c:
                continue
            c = "[" + c
            brace = c.find("{")
            if brace == -1:
                continue
            json_text = c[brace:]

            # Use safe JSON parsing
            obj = self._safe_json_parse(json_text)
            if not isinstance(obj, dict):
                continue

            msg_type = obj.get("type")
            ts = obj.get("ts")
            if not isinstance(ts, int):
                continue
            if ts <= last_tool_ts:
                continue

            # Structured prompt logging (emitted by extension via ROO_CODE_MESSAGE_LOG_PATH)
            if msg_type == "log" and obj.get("log") == "system_prompt":
                try:
                    phase = obj.get("phase")
                    system_hash = obj.get("systemPromptHash")
                    guidance_hash = obj.get("phaseGuidanceHash")
                    tests_run = obj.get("testsRunCount")
                    mods = obj.get("modificationCount")
                    details = (
                        f"phase={phase} testsRun={tests_run} mods={mods} "
                        f"systemPromptHash={system_hash} phaseGuidanceHash={guidance_hash}"
                    )
                except Exception:
                    details = json.dumps(obj, ensure_ascii=False)[:400]

                log_entry = self._format_log_entry("AGENT_PROMPT", details)
                if self._safe_file_write(progress_log_path, log_entry):
                    last_tool_ts = ts
                continue

            # Handle ask type "command" - text is the command string directly
            if msg_type == "ask" and obj.get("ask") == "command":
                cmd_text = obj.get("text", "")
                if isinstance(cmd_text, str) and cmd_text.strip():
                    # Clean command text for single-line logging
                    clean_cmd = cmd_text.strip().replace("\n", " ").replace("\r", " ")
                    log_entry = self._format_log_entry("AGENT_TOOL", f"execute_command {clean_cmd}")
                    if self._safe_file_write(progress_log_path, log_entry):
                        last_tool_ts = ts
                continue

            if msg_type == "ask" and obj.get("ask") == "use_mcp_server":
                tool_payload = obj.get("text")
                tool_name_str = "use_mcp_tool"
                summary_str = ""
                if isinstance(tool_payload, str):
                    payload_obj = self._safe_json_parse(tool_payload)
                    if isinstance(payload_obj, dict):
                        payload_type = payload_obj.get("type")
                        if payload_type == "use_mcp_tool":
                            server_name = payload_obj.get("serverName")
                            mcp_tool_name = payload_obj.get("toolName")
                            tool_name_str = "use_mcp_tool"
                            summary_str = (
                                f"server={server_name} tool={mcp_tool_name}"
                                if server_name or mcp_tool_name
                                else json.dumps(payload_obj, ensure_ascii=False)[:400]
                            )
                        else:
                            tool_name_str = str(payload_type or "use_mcp_server")
                            summary_str = json.dumps(payload_obj, ensure_ascii=False)[:400]
                    else:
                        tool_name_str = "use_mcp_server"
                        summary_str = tool_payload[:400]
                log_entry = self._format_log_entry("AGENT_TOOL", f"{tool_name_str} {summary_str}")
                if self._safe_file_write(progress_log_path, log_entry):
                    last_tool_ts = ts
                continue

            # Handle ask type "tool" - text is JSON with tool info
            if msg_type == "ask" and obj.get("ask") == "tool":
                tool_payload = obj.get("text")
                tool_name = None
                tool_summary = None
                if isinstance(tool_payload, str):
                    payload_obj = self._safe_json_parse(tool_payload)
                    if isinstance(payload_obj, dict):
                        tool_name = payload_obj.get("tool")
                        if tool_name in {"execute_command", "run_command", "command"}:
                            # Be tolerant to differing payload schemas.
                            # Prefer extracting the command string if present under common keys.
                            for k in (
                                "command",
                                "cmd",
                                "commandLine",
                                "CommandLine",
                                "shellCommand",
                                "argv",
                                "args",
                                "arguments",
                            ):
                                v = payload_obj.get(k)
                                if isinstance(v, str) and v.strip():
                                    tool_summary = v.strip().replace("\n", " ").replace("\r", " ")
                                    break
                                if isinstance(v, list) and v:
                                    try:
                                        tool_summary = " ".join(str(x) for x in v if x is not None).strip()
                                        tool_summary = tool_summary.replace("\n", " ").replace("\r", " ")
                                    except Exception:
                                        tool_summary = None
                                    if tool_summary:
                                        break
                            if tool_summary is None:
                                tool_summary = json.dumps(payload_obj, ensure_ascii=False)[:400]
                        elif tool_name:
                            tool_summary = json.dumps(payload_obj, ensure_ascii=False)[:400]
                    else:
                        # If it's not JSON, still emit a record so we don't silently drop tool calls.
                        tool_name = "tool"
                        tool_summary = tool_payload[:400]
                tool_name_str = str(tool_name or "tool")
                summary_str = str(tool_summary or "")
                log_entry = self._format_log_entry("AGENT_TOOL", f"{tool_name_str} {summary_str}")
                if self._safe_file_write(progress_log_path, log_entry):
                    last_tool_ts = ts
                continue

            # Handle say type "command_output" - capture command execution output
            if msg_type == "say" and obj.get("say") == "command_output":
                output_text = obj.get("text", "")
                if isinstance(output_text, str) and output_text.strip():
                    # Truncate long output and replace newlines for single-line logging
                    truncated = output_text[:500].replace("\n", "\\n").replace("\r", "\\r")
                    if len(output_text) > 500:
                        truncated += "..."
                    log_entry = self._format_log_entry("AGENT_OUTPUT", f"command_output {truncated}")
                    if self._safe_file_write(progress_log_path, log_entry):
                        last_tool_ts = ts
                continue

            # Handle XML-style execute_command in say messages (legacy format)
            if msg_type == "say" and isinstance(obj.get("text"), str) and "<execute_command>" in obj.get("text", ""):
                m = re.search(
                    r"<execute_command>.*?<command>(.*?)</command>.*?</execute_command>",
                    obj.get("text", ""),
                    re.DOTALL,
                )
                cmd_text = (m.group(1).strip() if m else "").replace("\n", " ").replace("\r", " ")
                if cmd_text:
                    log_entry = self._format_log_entry("AGENT_TOOL", f"execute_command {cmd_text}")
                    if self._safe_file_write(progress_log_path, log_entry):
                        last_tool_ts = ts
                continue

            continue

        return last_tool_ts

    def _sync_costrict_messages_log_from_workspace_tmp(
        self,
        *,
        runner_container: Any,
        instance_id: str,
        instance_dir: str,
        last_bytes_by_filename: Dict[str, int],
        max_bytes: int = 2_000_000,
    ) -> Dict[str, int]:
        list_cmd = (
            "ls -1 /workspace/tmp 2>/dev/null | "
            + f"grep -E '^costrict-messages-{re.escape(instance_id)}-' || true"
        )
        res = runner_container.exec_run(["bash", "-lc", list_cmd], demux=True)
        stdout_b, _stderr_b = res.output if res.output else (b"", b"")
        listing = stdout_b.decode(errors="replace") if stdout_b else ""
        files = [line.strip() for line in listing.splitlines() if line.strip()]
        if not files:
            return last_bytes_by_filename

        for filename in files[-3:]:
            container_path = f"/workspace/tmp/{filename}"
            size_cmd = f"stat -c %s {shlex.quote(container_path)} 2>/dev/null || echo 0"
            res_size = runner_container.exec_run(["bash", "-lc", size_cmd], demux=True)
            stdout_size_b, _stderr_size_b = res_size.output if res_size.output else (b"", b"")
            size_str = stdout_size_b.decode(errors="replace").strip() if stdout_size_b else "0"
            try:
                size = int(size_str)
            except Exception:
                size = 0

            last = int(last_bytes_by_filename.get(filename, 0) or 0)
            if size <= last:
                continue

            if size - last > max_bytes:
                last = max(0, size - max_bytes)

            start = last + 1
            read_cmd = f"tail -c +{start} {shlex.quote(container_path)} 2>/dev/null || true"
            res_read = runner_container.exec_run(["bash", "-lc", read_cmd], demux=True)
            stdout_new_b, _stderr_new_b = res_read.output if res_read.output else (b"", b"")
            new_text = stdout_new_b.decode(errors="replace") if stdout_new_b else ""
            if not new_text:
                last_bytes_by_filename[filename] = size
                continue

            host_path = os.path.join(instance_dir, filename)
            self._safe_file_write(host_path, new_text)
            last_bytes_by_filename[filename] = size

        return last_bytes_by_filename

    def resolve_repo_dir(self, container: Any, workdir: str = "/testbed") -> str:
        """Detect where the repo lives inside the image.

        Common layouts:
        - /testbed (git repo)
        - /testbed/repo (git repo)
        """
        candidates = [workdir, f"{workdir}/repo"]
        for d in candidates:
            result = container.exec_run(["bash", "-lc", f"test -d {d}/.git"], demux=True)
            if int(result.exit_code) == 0:
                return d
        raise RuntimeError(f"No git repo found under {workdir} (checked: {candidates})")

    def _resolve_repo_url(self, repo: str) -> str:
        if repo.startswith("http://") or repo.startswith("https://") or repo.startswith("git@"):  # noqa: S105
            return repo
        if repo.count("/") == 1:
            return f"https://github.com/{repo}.git"
        return repo

    def _render_env_startup_command(self, instance: SWEInstance, command_template: str) -> str:
        template = Template(command_template, undefined=StrictUndefined)
        return template.render(
            instance_id=instance.instance_id,
            repo=instance.repo,
            base_commit=instance.base_commit,
        )
    
    def bootstrap_repo(
        self,
        container: Any,
        instance: SWEInstance,
        repo_dir: str,
    ) -> Tuple[int, str, str]:
        """Bootstrap repo following harness-style images: checkout only (no clone)."""
        cmd = (
            "set -euo pipefail; "
            f"cd {repo_dir}; "
            "git reset --hard; "
            f"git checkout -f {instance.base_commit}; "
            "git clean -fd; "
            "git rev-parse HEAD; "
            "git status --porcelain=v1 || true"
        )

        result = container.exec_run(["bash", "-lc", cmd], demux=True)
        stdout_b, stderr_b = result.output if result.output else (b"", b"")
        stdout = stdout_b.decode(errors="replace") if stdout_b else ""
        stderr = stderr_b.decode(errors="replace") if stderr_b else ""
        
        logger.info(
            "Bootstrapped repository",
            instance_id=instance.instance_id,
            exit_code=result.exit_code,
        )

        return int(result.exit_code), stdout, stderr
    
    def run_startup_command(
        self,
        container: Any,
        command: str,
        workspace_dir: str,
    ) -> Tuple[int, str, str]:
        """Run environment startup command in container."""
        result = container.exec_run(["bash", "-lc", f"cd {workspace_dir} && {command}"], demux=True)
        stdout_b, stderr_b = result.output if result.output else (b"", b"")
        stdout = stdout_b.decode(errors="replace") if stdout_b else ""
        stderr = stderr_b.decode(errors="replace") if stderr_b else ""
        
        logger.info(
            "Ran startup command",
            command=command,
            exit_code=result.exit_code,
        )

        return int(result.exit_code), stdout, stderr

    def render_and_run_startup_command(
        self,
        container: Any,
        instance: SWEInstance,
        command_template: str,
        workspace_dir: str,
    ) -> Tuple[int, str, str, str]:
        """Render env_startup_command with StrictUndefined and execute it."""
        rendered = self._render_env_startup_command(instance, command_template)
        exit_code, stdout, stderr = self.run_startup_command(
            container=container,
            command=rendered,
            workspace_dir=workspace_dir,
        )
        return exit_code, stdout, stderr, rendered
    
    def run_tests(
        self,
        container: Any,
        test_commands: list[str],
        workspace_dir: str,
    ) -> Dict[str, Dict[str, object]]:
        """Run test commands in container."""
        results = {}

        py_path = f"{workspace_dir}:{workspace_dir}/lib:{workspace_dir}/src:${{PYTHONPATH:-}}"

        def is_pytest_nodeid(s: str) -> bool:
            s = s.strip()
            if not s:
                return False
            # If it already looks like an explicit shell command, don't wrap.
            lowered = s.lower()
            if (
                " " in s
                or lowered.startswith("pytest")
                or lowered.startswith("python -m pytest")
                or lowered.startswith("python3 -m pytest")
                or lowered.startswith("tox")
            ):
                return False
            # SWE-bench provides pytest node ids like path/to/test_file.py::test_name
            return "::" in s
        
        for test_cmd in test_commands:
            test_cmd = (test_cmd or "").strip()
            if not test_cmd:
                continue

            if is_pytest_nodeid(test_cmd):
                exec_cmd = f"python -m pytest -q {shlex.quote(test_cmd)}"
            else:
                exec_cmd = test_cmd

            full_cmd = f"export PYTHONPATH={shlex.quote(py_path)}; cd {workspace_dir} && {exec_cmd}"
            result = container.exec_run(["bash", "-lc", full_cmd], demux=True)
            stdout_b, stderr_b = result.output if result.output else (b"", b"")
            stdout = stdout_b.decode(errors="replace") if stdout_b else ""
            stderr = stderr_b.decode(errors="replace") if stderr_b else ""
            results[test_cmd] = {
                "exit_code": int(result.exit_code),
                "stdout": stdout,
                "stderr": stderr,
                "passed": result.exit_code == 0,
                "executed": exec_cmd,
            }
        
        return results

    def export_repo_to_host(self, container: Any, repo_dir: str, dest_dir: Path) -> None:
        dest_dir = Path(dest_dir)
        if dest_dir.exists():
            shutil.rmtree(dest_dir)
        dest_dir.mkdir(parents=True, exist_ok=True)

        stream, _stat = container.get_archive(repo_dir)
        buf = BytesIO()
        for chunk in stream:
            buf.write(chunk)
        buf.seek(0)

        with tarfile.open(fileobj=buf, mode="r|*") as tf:
            for member in tf:
                if member is None:
                    continue
                member_path = member.name
                parts = member_path.split("/", 1)
                if len(parts) == 2:
                    member.name = parts[1]
                else:
                    member.name = ""
                if not member.name:
                    continue
                tf.extract(member, path=dest_dir)

    def apply_patch_in_container(self, container: Any, repo_dir: str, patch: str) -> Tuple[int, str, str]:
        patch = patch.replace("\r\n", "\n")
        if patch and not patch.endswith("\n"):
            patch += "\n"
        patch_b64 = base64.b64encode(patch.encode("utf-8", errors="replace")).decode("ascii")
        patch_id = uuid.uuid4().hex[:10]
        cmd = (
            "set -euo pipefail; "
            f"tmp=/tmp/costrict_patch_{patch_id}.diff; "
            f"echo '{patch_b64}' | base64 -d > $tmp; "
            f"cd {repo_dir}; "
            "git apply --whitespace=nowarn $tmp; "
            "rm -f $tmp; "
            "git status --porcelain=v1 || true"
        )

        result = container.exec_run(["bash", "-lc", cmd], demux=True)
        stdout_b, stderr_b = result.output if result.output else (b"", b"")
        stdout = stdout_b.decode(errors="replace") if stdout_b else ""
        stderr = stderr_b.decode(errors="replace") if stderr_b else ""
        return int(result.exit_code), stdout, stderr
