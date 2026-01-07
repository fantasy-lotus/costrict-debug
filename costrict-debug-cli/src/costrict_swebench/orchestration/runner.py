"""Core orchestration logic for running SWE-bench evaluations."""

import asyncio
import json
import os
import signal
import subprocess
import sys
import shutil
import re
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

import structlog
from concurrent.futures import ThreadPoolExecutor

from costrict_swebench.domain.models import (
    ExitStatus,
    InstanceMetadata,
    InstanceStatus,
    SWEInstance,
    Trajectory,
    TrajectoryInfo,
    TrajectoryMessage,
)
from costrict_swebench.domain.types import RunConfig
from costrict_swebench.infra.data_loader import SWEInstanceLoader, resolve_image_name
from costrict_swebench.infra.docker import DockerManager
from costrict_swebench.infra.filesystem import (
    RunDirectory,
    append_instance_text_log,
    save_instance_json,
    save_instance_metadata,
    save_instance_text_log,
    save_patch,
    save_trajectory,
    update_run_metadata,
)
from costrict_swebench.infra.predictions import PredictionsManager, Prediction

logger = structlog.get_logger()


async def _progress(
    run_dir: RunDirectory,
    instance_id: str,
    message: str,
    **fields: object,
) -> None:
    logger.info(message, instance_id=instance_id, **fields)
    ts = datetime.utcnow().isoformat()
    extra = "" if not fields else " " + json.dumps(fields, ensure_ascii=False, sort_keys=True)
    await append_instance_text_log(run_dir, instance_id, "progress.log", f"[{ts}] {message}{extra}\n")


def _copytree_replace(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def run_official_harness_verification(
    *,
    instance_id: str,
    dataset: str,
    split: str,
    run_id: str,
    model_name_or_path: str,
    predictions_jsonl_path: Path,
    instance_dir: Path,
    max_workers: int = 1,
    cache_level: str = "env",
    clean: bool = True,
) -> Dict[str, object]:
    """Run the official SWE-bench harness for a single instance.

    This uses the local Python environment's `swebench` installation and Docker.
    It writes harness artifacts back into the instance_dir.
    """
    run_id_official = f"{run_id}-official"
    cmd = [
        sys.executable,
        "-m",
        "swebench.harness.run_evaluation",
        "--dataset_name",
        dataset,
        "--split",
        split,
        "--predictions_path",
        str(predictions_jsonl_path),
        "--instance_ids",
        instance_id,
        "--max_workers",
        str(max_workers),
        "--run_id",
        run_id_official,
        "--cache_level",
        cache_level,
        "--clean",
        "True" if clean else "False",
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, env=os.environ.copy())
    (instance_dir / "official_harness.stdout.txt").write_text(result.stdout or "")
    (instance_dir / "official_harness.stderr.txt").write_text(result.stderr or "")

    # Copy top-level report JSON (model_name_or_path.run_id.json)
    report_filename = f"{model_name_or_path}.{run_id_official}.json"
    report_path = Path.cwd() / report_filename
    parsed_report: Dict[str, object] = {}
    if report_path.exists():
        instance_report_copy = instance_dir / "official_harness.report.summary.json"
        instance_report_copy.write_text(report_path.read_text())
        try:
            parsed_report = json.loads(report_path.read_text())
        except Exception:
            parsed_report = {}

    # Copy per-instance harness artifacts
    harness_logs_root = Path.cwd() / "logs" / "run_evaluation" / run_id_official
    per_instance_src = harness_logs_root / model_name_or_path / instance_id
    per_instance_dst = instance_dir / "official_harness"
    if per_instance_src.exists():
        _copytree_replace(per_instance_src, per_instance_dst)

    resolved_ids = parsed_report.get("resolved_ids") if isinstance(parsed_report, dict) else None
    resolved = False
    if isinstance(resolved_ids, list):
        resolved = instance_id in resolved_ids

    # If summary report wasn't readable, fall back to per-instance report.json
    if not resolved and per_instance_dst.exists():
        try:
            per_instance_report = json.loads((per_instance_dst / "report.json").read_text())
            entry = per_instance_report.get(instance_id)
            if isinstance(entry, dict) and "resolved" in entry:
                resolved = bool(entry.get("resolved"))
        except Exception:
            pass

    return {
        "run_id": run_id_official,
        "resolved": resolved,
        "returncode": result.returncode,
        "report_path": str(report_path) if report_path.exists() else None,
        "logs_path": str(per_instance_src) if per_instance_src.exists() else None,
    }


class SWEOrchestrator:
    """Main orchestrator for SWE-bench evaluation."""

    def __init__(self, run_id: str, base_dir: Optional[Path] = None, api_provider: str = "zgsm"):
        self.run_id = run_id
        self.run_dir = RunDirectory(run_id, base_dir)
        self.predictions_manager = PredictionsManager(self.run_dir.path)
        self.docker_manager = DockerManager()
        self.api_provider = api_provider

    def _prepare_prompt(self, instance: SWEInstance) -> str:
        hint_block = ""
        if getattr(instance, "hints_text", None):
            hint_block = f"\n\nHints:\n{instance.hints_text}"  # type: ignore[attr-defined]

        test_instructions_block = ""
        if instance.repo == "django/django":
            f2p_commands: List[str] = []
            for raw in instance.FAIL_TO_PASS:
                m = re.match(r"^(?P<test>\S+)\s*\((?P<label>[^)]+)\)\s*$", str(raw).strip())
                if not m:
                    continue
                test_name = m.group("test")
                label = m.group("label")
                full_label = f"{label}.{test_name}"
                module_label = label.rsplit(".", 1)[0] if "." in label else label
                f2p_commands.append(
                    f"- cd $(git rev-parse --show-toplevel)/tests && ./runtests.py --verbosity 2 --settings=test_sqlite --parallel 1 {full_label}"
                )
                f2p_commands.append(
                    f"- cd $(git rev-parse --show-toplevel)/tests && ./runtests.py --verbosity 2 --settings=test_sqlite --parallel 1 {label}"
                )
                if module_label and module_label != label:
                    f2p_commands.append(
                        f"- cd $(git rev-parse --show-toplevel)/tests && ./runtests.py --verbosity 2 --settings=test_sqlite --parallel 1 {module_label}"
                    )

            f2p_commands_block = ""
            if f2p_commands:
                f2p_commands_block = "\n\nConcrete FAIL_TO_PASS commands (run these first):\n" + "\n".join(
                    f2p_commands
                )

            test_instructions_block = (
                "\n\nRepo-specific testing instructions:\n"
                "- This repo uses Django's internal test runner (unittest-based): ./tests/runtests.py\n"
                "- Recommended command: ./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1\n"
                "- Prefer running a single test by dotted label (package/module/class/method):\n"
                "  app.tests.Module.TestCase.test_method\n"
                "- If FAIL_TO_PASS provides: test_name (module.Class), do NOT grep for test_name; run: module.Class.test_name\n"
                "- If method-level label fails, fall back to class-level, then module-level label\n"
                "- Prefer bash-first discovery (execute_command) over searchFiles to avoid flaky 0-results:\n"
                "  cd $(git rev-parse --show-toplevel)\n"
                "  ls tests\n"
                "  find tests -maxdepth 2 -type f -name 'test_*.py' | head\n"
                "  grep -rn \"def test_<name>\" tests/\n"
                "  grep -rn \"test_<name>\" tests/\n"
                "  grep -rn \"class <ClassName>\" tests/\n"
                f"{f2p_commands_block}"
            )

        workflow_block = (
            "SWE-bench Workflow (MUST FOLLOW EXACTLY)\n"
            "0) FAIL_TO_PASS / PASS_TO_PASS tests are GUARANTEED to exist in this environment.\n"
            "   - If you cannot find/run them, your search path, test runner, or invocation format is wrong.\n"
            "   - It is NOT possible that these tests do not exist. Do NOT claim they are missing.\n"
            "1) Do NOT create, modify, or delete any test files or test methods.\n"
            "2) Before running ANY tests, you MUST complete project exploration to satisfy the harness gates:\n"
            "   - Read README / testing docs.\n"
            "   - List the test directory structure and locate the target tests (by searching for their names).\n"
            "3) After exploration is complete, run the FAIL_TO_PASS tests listed below to capture the exact failure.\n"
            "4) Only after FAIL_TO_PASS are understood and fixed, run the PASS_TO_PASS tests listed below.\n"
            "5) Use the repository's documented test runner when available (many repos are not pure pytest).\n"
            "\n"
            "MCP sequential-thinking (use_mcp_tool) rules:\n"
            "- Default: call it ONCE at the start of analysis to rank hypotheses and pick the next verification step.\n"
            "- Difficulty → totalThoughts guideline: easy=3, medium=5, hard=8-12.\n"
            "- Call it again after 2 failed patch→verify cycles or when new evidence contradicts your main hypothesis.\n"
            "- Before apply_diff, call it if your plan is not already crisp and testable.\n"
        )

        prompt = (
            f"{workflow_block}\n"
            f"Repository: {instance.repo}\n"
            f"Base commit: {instance.base_commit}\n\n"
            f"Problem Statement:\n{instance.problem_statement}{hint_block}{test_instructions_block}\n\n"
            "FAIL_TO_PASS tests that must pass:\n"
            f"{chr(10).join(f'- {test}' for test in instance.FAIL_TO_PASS)}\n\n"
            "PASS_TO_PASS tests that must not fail:\n"
            f"{chr(10).join(f'- {test}' for test in instance.PASS_TO_PASS)}\n"
        )
        return prompt

    async def run_single_instance(
        self,
        instance: SWEInstance,
        timeout: int = 300,
        model_name_or_path: str = "costrict-swebench-v1",
        verify_mode: str = "local",
        cache_level: str = "env",
        clean: bool = True,
    ) -> Dict:
        """Run a single instance and return results."""
        instance_id = instance.instance_id
        logger.info(
            "Starting instance execution",
            instance_id=instance_id,
            run_id=self.run_id,
        )

        # Create instance metadata
        image_name = resolve_image_name(instance)
        metadata = InstanceMetadata(
            instance_id=instance_id,
            run_id=self.run_id,
            started_at=datetime.utcnow(),
            status=InstanceStatus.RUNNING,
            image_name_resolved=image_name,
            image_name_source="instance.image_name" if instance.image_name else "derived_from_instance_id",
        )

        # Ensure directories exist
        instance_dir = self.run_dir.ensure_instance_dir(instance_id)

        trajectory: Optional[Trajectory] = None
        patch: Optional[str] = None
        test_results: Optional[Dict[str, Dict[str, object]]] = None
        official_result: Optional[Dict[str, object]] = None
        workspace_volume: Optional[str] = None

        try:
            # Save initial metadata
            await save_instance_metadata(self.run_dir, metadata)

            # Step 1: Start SWE-bench instance container
            logger.info(
                "Starting SWE-bench instance container",
                instance_id=instance_id,
                image_name=image_name,
            )

            workspace_volume = self.docker_manager.create_workspace_volume()
            instance_container = self.docker_manager.create_instance_container(
                instance=instance,
                workspace_volume=workspace_volume,
                workspace_container="/workspace",
            )

            repo_dir = self.docker_manager.resolve_repo_dir(instance_container, workdir="/testbed")
            workspace_repo_dir = "/workspace/repo"

            # Step 2: Bootstrap the repository
            logger.info(
                "Bootstrapping repository",
                instance_id=instance_id,
            )

            exit_code, stdout, stderr = self.docker_manager.bootstrap_repo(
                container=instance_container,
                instance=instance,
                repo_dir=repo_dir,
            )

            await save_instance_text_log(self.run_dir, instance_id, "bootstrap.stdout.txt", stdout)
            await save_instance_text_log(self.run_dir, instance_id, "bootstrap.stderr.txt", stderr)

            if exit_code != 0:
                metadata.error_message = f"Bootstrap failed: {stderr.strip()}"
                metadata.error_type = "BootstrapError"
                metadata.exit_status = ExitStatus.ERROR
                raise Exception(metadata.error_message)

            # Step 2.5: Copy repo from image location into shared workspace volume (no host usage).
            logger.info(
                "Copying repo into shared workspace",
                instance_id=instance_id,
                src_repo_dir=repo_dir,
                dst_repo_dir=workspace_repo_dir,
                volume=workspace_volume,
            )
            copy_exit, copy_stdout, copy_stderr = self.docker_manager.copy_repo_to_workspace(
                container=instance_container,
                src_repo_dir=repo_dir,
                dst_repo_dir=workspace_repo_dir,
            )
            await save_instance_text_log(self.run_dir, instance_id, "workspace_copy.stdout.txt", copy_stdout)
            await save_instance_text_log(self.run_dir, instance_id, "workspace_copy.stderr.txt", copy_stderr)
            if copy_exit != 0:
                metadata.error_message = f"Workspace copy failed: {copy_stderr.strip()}"
                metadata.error_type = "WorkspaceCopyError"
                metadata.exit_status = ExitStatus.ERROR
                raise Exception(metadata.error_message)

            # Step 3: Run env_startup_command if present
            if instance.env_startup_command:
                logger.info(
                    "Running environment startup command",
                    instance_id=instance_id,
                    command=instance.env_startup_command,
                )

                try:
                    exit_code, stdout, stderr, rendered = self.docker_manager.render_and_run_startup_command(
                        container=instance_container,
                        instance=instance,
                        command_template=instance.env_startup_command,
                        workspace_dir=workspace_repo_dir,
                    )
                except Exception as e:
                    metadata.error_message = f"Startup command render failed: {e}"
                    metadata.error_type = "StartupCommandRenderError"
                    metadata.exit_status = ExitStatus.ERROR
                    raise

                await save_instance_text_log(self.run_dir, instance_id, "startup.rendered.txt", rendered)
                await save_instance_text_log(self.run_dir, instance_id, "startup.stdout.txt", stdout)
                await save_instance_text_log(self.run_dir, instance_id, "startup.stderr.txt", stderr)

                if exit_code != 0:
                    metadata.error_message = f"Startup command failed: {stderr.strip()}"
                    metadata.error_type = "StartupCommandError"
                    metadata.exit_status = ExitStatus.ERROR
                    raise Exception(metadata.error_message)

            # Step 4: Run CoStrict agent
            await _progress(self.run_dir, instance_id, "Running CoStrict agent")

            prompt = self._prepare_prompt(instance)
            prompt_file_path = "/workspace/prompt.md"
            self.docker_manager.write_text_file_in_container(
                container=instance_container,
                path=prompt_file_path,
                content=prompt,
                mode="0644",
            )

            host_vsix_path = os.environ.get("COSTRICT_RUNNER_VSIX_PATH") or os.environ.get(
                "ROO_CODE_RUNNER_VSIX_PATH"
            )
            if host_vsix_path and not os.path.exists(host_vsix_path):
                logger.warning(
                    "Runner VSIX path does not exist; ignoring",
                    instance_id=instance_id,
                    host_vsix_path=host_vsix_path,
                )
                host_vsix_path = None

            await _progress(
                self.run_dir,
                instance_id,
                "Starting runner container (costrict-evals-runner:dev)",
                verify_mode=verify_mode,
                host_vsix_path=host_vsix_path,
            )

            try:
                costrict_result = self.docker_manager.run_costrict_swe_task_in_runner_container(
                    volume_name=workspace_volume,
                    instance_container_ref=getattr(instance_container, "name", None)
                    or getattr(instance_container, "id", None),
                    container_workdir=workspace_repo_dir,
                    host_vsix_path=host_vsix_path,
                    progress_log_path=str(instance_dir / "progress.log"),
                    instance_id=instance_id,
                    workspace_path=workspace_repo_dir,
                    prompt_file_path=prompt_file_path,
                    timeout_seconds=timeout,
                    include_timeout_ms=True,
                    mode="swebench",
                    api_provider=self.api_provider,
                )
            except RuntimeError as e:
                msg = str(e)
                if "Unknown arguments" in msg and "--timeout-ms" in msg:
                    logger.warning(
                        "Runner image does not support --timeout-ms; retrying without it. "
                        "Rebuild costrict-evals-runner:dev image to enable true timeout alignment.",
                        instance_id=instance_id,
                        run_id=self.run_id,
                    )
                    costrict_result = self.docker_manager.run_costrict_swe_task_in_runner_container(
                        volume_name=workspace_volume,
                        instance_container_ref=getattr(instance_container, "name", None)
                        or getattr(instance_container, "id", None),
                        container_workdir=workspace_repo_dir,
                        host_vsix_path=host_vsix_path,
                        progress_log_path=str(instance_dir / "progress.log"),
                        instance_id=instance_id,
                        workspace_path=workspace_repo_dir,
                        prompt_file_path=prompt_file_path,
                        timeout_seconds=timeout,
                        include_timeout_ms=False,
                        mode="swebench",
                        api_provider=self.api_provider,
                    )
                else:
                    raise

            await _progress(
                self.run_dir,
                instance_id,
                "Runner container finished",
                runner_container_name=costrict_result.get("runner_container_name"),
            )

            runner_stdout_tail = str(costrict_result.get("runner_stdout_tail") or "")
            if runner_stdout_tail:
                await save_instance_text_log(self.run_dir, instance_id, "runner.stdout.tail.txt", runner_stdout_tail)

            patch = str(costrict_result.get("patch") or "")
            trajectory_data = costrict_result.get("trajectory")

            await _progress(
                self.run_dir,
                instance_id,
                "Parsed runner structured result",
                patch_generated=bool(patch),
                patch_size=len(patch),
            )

            # Step 4b: Persist agent logs from shared workspace (written by evals runTask.ts)
            # These files are written into the workspace parent directory: path.dirname(workspace_repo_dir).
            workspace_parent_dir = os.path.dirname(workspace_repo_dir.rstrip("/"))
            agent_log_candidates = [
                f"{workspace_parent_dir}/swe-{instance_id}.1_exthost.log",
                f"{workspace_parent_dir}/swe-{instance_id}.1_CoStrict.log",
                f"{workspace_parent_dir}/swe-{instance_id}.1_costrict-messages.log",
                f"{workspace_parent_dir}/swe-{instance_id}.1_api_conversation_history.json",
                f"{workspace_parent_dir}/swe-{instance_id}.1_ui_messages.json",
            ]
            for src_path in agent_log_candidates:
                exit_code, stdout, _stderr = self.docker_manager.read_text_file_in_container(
                    container=instance_container,
                    path=src_path,
                    max_bytes=2_000_000,
                )
                if exit_code == 0 and stdout:
                    await save_instance_text_log(
                        self.run_dir,
                        instance_id,
                        os.path.basename(src_path),
                        stdout,
                    )

            messages: List[TrajectoryMessage] = []
            if isinstance(trajectory_data, list):
                for msg in trajectory_data:
                    if isinstance(msg, dict) and "role" in msg and "content" in msg:
                        messages.append(
                            TrajectoryMessage(
                                role=str(msg.get("role")),
                                content=str(msg.get("content")),
                            )
                        )

            trajectory = Trajectory(
                info=TrajectoryInfo(
                    exit_status=ExitStatus.SUCCESS if patch else ExitStatus.FAILED,
                    result={
                        "patch_generated": bool(patch),
                        "patch_size": len(patch),
                    },
                ),
                messages=messages,
            )

            failed_tests: List[str] = []
            if verify_mode == "official":
                # Official verification: delegate to swebench.harness and treat its resolved/unresolved as source of truth.
                await save_patch(self.run_dir, instance_id, patch)
                prediction = Prediction(
                    instance_id=instance_id,
                    model_patch=patch or "",
                    model_name_or_path=model_name_or_path,
                    metadata={
                        "exit_status": "pending",
                        "total_duration_seconds": None,
                    },
                )
                self.predictions_manager.write_prediction(prediction)

                await _progress(
                    self.run_dir,
                    instance_id,
                    "Starting official harness verification",
                    run_id=f"{self.run_id}-official",
                    cache_level=cache_level,
                    clean=clean,
                )

                official_result = run_official_harness_verification(
                    instance_id=instance_id,
                    dataset="princeton-nlp/SWE-bench_Verified",
                    split="test",
                    run_id=self.run_id,
                    model_name_or_path=model_name_or_path,
                    predictions_jsonl_path=self.predictions_manager.predictions_jsonl_path,
                    instance_dir=instance_dir,
                    cache_level=cache_level,
                    clean=clean,
                )

                await _progress(
                    self.run_dir,
                    instance_id,
                    "Official harness finished",
                    resolved=bool(official_result.get("resolved")),
                    returncode=official_result.get("returncode"),
                    report_path=official_result.get("report_path"),
                    logs_path=official_result.get("logs_path"),
                )

                if bool(official_result.get("resolved")):
                    metadata.exit_status = ExitStatus.SUCCESS
                else:
                    metadata.exit_status = ExitStatus.FAILED
                    metadata.error_message = "Official harness marked unresolved"
                    metadata.error_type = "OfficialHarnessUnresolved"
            elif verify_mode == "local":
                # Local verification: apply patch and run explicit nodeid tests.
                await _progress(
                    self.run_dir,
                    instance_id,
                    "Local verification: applying patch in container",
                    repo_dir=workspace_repo_dir,
                    patch_size=len(patch) if patch else 0,
                )

                # The runner container edits the shared workspace repo directly.
                # Reset to base_commit before applying patch so we verify patch applicability and avoid double-apply.
                reset_exit, reset_stdout, reset_stderr = self.docker_manager.bootstrap_repo(
                    container=instance_container,
                    instance=instance,
                    repo_dir=workspace_repo_dir,
                )
                await _progress(
                    self.run_dir,
                    instance_id,
                    "Workspace reset finished",
                    exit_code=int(reset_exit),
                )
                await save_instance_text_log(self.run_dir, instance_id, "reset.stdout.txt", reset_stdout)
                await save_instance_text_log(self.run_dir, instance_id, "reset.stderr.txt", reset_stderr)
                if reset_exit != 0:
                    metadata.error_message = f"Workspace reset failed: {reset_stderr.strip()}"
                    metadata.error_type = "WorkspaceResetError"
                    metadata.exit_status = ExitStatus.ERROR
                    raise Exception(metadata.error_message)

                apply_exit, apply_stdout, apply_stderr = self.docker_manager.apply_patch_in_container(
                    container=instance_container,
                    repo_dir=workspace_repo_dir,
                    patch=patch or "",
                )
                await _progress(
                    self.run_dir,
                    instance_id,
                    "Patch apply finished",
                    exit_code=int(apply_exit),
                )
                await save_instance_text_log(self.run_dir, instance_id, "apply.stdout.txt", apply_stdout)
                await save_instance_text_log(self.run_dir, instance_id, "apply.stderr.txt", apply_stderr)

                if apply_exit != 0:
                    metadata.error_message = f"Patch apply failed: {apply_stderr.strip()}"
                    metadata.error_type = "PatchApplyError"
                    metadata.exit_status = ExitStatus.ERROR
                    raise Exception(metadata.error_message)

                await _progress(self.run_dir, instance_id, "Running tests")
                test_results_local = self.docker_manager.run_tests(
                    container=instance_container,
                    test_commands=instance.FAIL_TO_PASS + instance.PASS_TO_PASS,
                    workspace_dir=workspace_repo_dir,
                )

                await _progress(
                    self.run_dir,
                    instance_id,
                    "Tests finished",
                    failed_fail_to_pass=len(
                        [
                            cmd
                            for cmd, res in test_results_local.items()
                            if cmd in instance.FAIL_TO_PASS and isinstance(res, dict) and not bool(res.get("passed"))
                        ]
                    ),
                )

                test_results = test_results_local
                await save_instance_json(self.run_dir, instance_id, "tests.json", test_results_local)
                tests_summary_lines: List[str] = []
                for cmd, res in test_results_local.items():
                    if isinstance(res, dict):
                        tests_summary_lines.append(
                            f"{cmd}: exit_code={res.get('exit_code')} passed={res.get('passed')}"
                        )
                await save_instance_text_log(
                    self.run_dir,
                    instance_id,
                    "tests.summary.txt",
                    "\n".join(tests_summary_lines) + "\n",
                )

                failed_tests = [
                    cmd
                    for cmd, res in test_results_local.items()
                    if cmd in instance.FAIL_TO_PASS and isinstance(res, dict) and not bool(res.get("passed"))
                ]

                if failed_tests:
                    logger.warning(
                        "Some tests failed",
                        instance_id=instance_id,
                        failed_tests=failed_tests,
                    )
                    metadata.error_message = f"Some tests failed: {failed_tests}"
                    metadata.error_type = "TestsFailed"
            elif verify_mode in {"none", "prediction"}:
                # Prediction-only mode: skip any verification (no reset/apply patch/run tests).
                await _progress(
                    self.run_dir,
                    instance_id,
                    "Skipping verification (prediction-only mode)",
                    verify_mode=verify_mode,
                )
                metadata.exit_status = ExitStatus.SUCCESS if patch else ExitStatus.FAILED
            else:
                raise ValueError(
                    f"Unsupported verify_mode={verify_mode!r} (expected 'none'|'prediction'|'local'|'official')"
                )

            # Save results
            await save_patch(self.run_dir, instance_id, patch)

            # Update metadata
            metadata.finished_at = datetime.utcnow()
            metadata.status = InstanceStatus.COMPLETED
            if verify_mode == "local":
                metadata.exit_status = ExitStatus.SUCCESS if not failed_tests else ExitStatus.FAILED
            metadata.total_duration_seconds = (
                metadata.finished_at - metadata.started_at
            ).total_seconds()

            await save_instance_metadata(self.run_dir, metadata)

            if trajectory is None:
                trajectory = Trajectory(
                    info=TrajectoryInfo(exit_status=metadata.exit_status),
                    messages=[
                        TrajectoryMessage(
                            role="system",
                            content="No trajectory captured (unexpected).",
                        )
                    ],
                )
            else:
                trajectory.info.exit_status = metadata.exit_status

            await save_trajectory(self.run_dir, instance_id, trajectory)

            # Write prediction
            prediction = Prediction(
                instance_id=instance_id,
                model_patch=patch or "",
                model_name_or_path=model_name_or_path,
                metadata={
                    "model_name_or_path": model_name_or_path,
                    "exit_status": metadata.exit_status,
                    "total_duration_seconds": metadata.total_duration_seconds,
                },
            )
            self.predictions_manager.write_prediction(prediction)

            logger.info(
                "Instance completed",
                instance_id=instance_id,
                duration=metadata.total_duration_seconds,
                exit_status=metadata.exit_status,
            )

            return {
                "success": metadata.exit_status == ExitStatus.SUCCESS,
                "instance_id": instance_id,
                "patch": patch,
                "trajectory": trajectory,
                "test_results": test_results,
                "failed_tests": failed_tests,
                "official_result": official_result,
                "error": metadata.error_message if metadata.exit_status != ExitStatus.SUCCESS else None,
            }

        except asyncio.TimeoutError:
            logger.error(
                "Instance timed out",
                instance_id=instance_id,
                timeout=timeout,
            )
            metadata.finished_at = datetime.utcnow()
            metadata.status = InstanceStatus.TIMEOUT
            metadata.exit_status = ExitStatus.TIMEOUT
            metadata.error_message = f"Instance timed out after {timeout} seconds"
            await save_instance_metadata(self.run_dir, metadata)

            trajectory = Trajectory(
                info=TrajectoryInfo(exit_status=metadata.exit_status),
                messages=[
                    TrajectoryMessage(
                        role="system",
                        content=metadata.error_message,
                    )
                ],
            )
            await save_trajectory(self.run_dir, instance_id, trajectory)

            return {
                "success": False,
                "instance_id": instance_id,
                "error": "timeout",
            }

        except Exception as e:
            logger.error(
                "Instance failed",
                instance_id=instance_id,
                error=str(e),
                exc_info=True,
            )
            metadata.finished_at = datetime.utcnow()
            metadata.status = InstanceStatus.FAILED
            metadata.exit_status = metadata.exit_status or ExitStatus.ERROR
            metadata.error_message = str(e)
            metadata.error_type = type(e).__name__
            await save_instance_metadata(self.run_dir, metadata)

            if trajectory is None:
                trajectory = Trajectory(
                    info=TrajectoryInfo(exit_status=metadata.exit_status),
                    messages=[
                        TrajectoryMessage(
                            role="system",
                            content=f"Execution failed: {metadata.error_message}",
                        )
                    ],
                )
            else:
                trajectory.info.exit_status = metadata.exit_status

            await save_trajectory(self.run_dir, instance_id, trajectory)

            return {
                "success": False,
                "instance_id": instance_id,
                "error": str(e),
            }
        finally:
            # Clean up containers
            try:
                if "instance_container" in locals() and instance_container is not None:
                    # Force remove to ensure cleanup even if container is still running or hung.
                    instance_container.remove(force=True)
            except Exception as e:
                logger.warning(
                    "Failed to clean up container",
                    instance_id=instance_id,
                    error=str(e),
                )

            try:
                if clean and verify_mode in {"none", "prediction"}:
                    self.docker_manager.remove_image(image_name, force=True)
            except Exception as e:
                logger.warning(
                    "Failed to clean up instance image",
                    instance_id=instance_id,
                    image_name=image_name,
                    error=str(e),
                )

            try:
                keep_runner = str(os.environ.get("COSTRICT_KEEP_RUNNER_CONTAINER", "")).strip().lower() in {
                    "1",
                    "true",
                    "yes",
                }
                if workspace_volume and not keep_runner:
                    self.docker_manager.remove_volume(workspace_volume)
            except Exception as e:
                logger.warning(
                    "Failed to clean up workspace volume",
                    instance_id=instance_id,
                    volume=workspace_volume,
                    error=str(e),
                )

    async def run_batch(
        self,
        dataset: str,
        split: str = "test",
        max_concurrency: int = 1,
        timeout: int = 300,
        model_name_or_path: str = "costrict-swebench-v1",
        resume: bool = False,
        instance_ids: Optional[List[str]] = None,
        verify_mode: str = "local",
        cache_level: str = "env",
        clean: bool = True,
    ) -> Dict[str, int]:
        """Run batch evaluation."""
        logger.info(
            "Starting batch run",
            dataset=dataset,
            split=split,
            max_concurrency=max_concurrency,
            resume=resume,
        )
        
        # Ensure run directory structure
        self.run_dir.ensure_structure()
        
        # Load instances
        instances = list(
            SWEInstanceLoader.load(
                source=dataset,
                split=split,
                instance_ids=instance_ids,
            )
        )

        # If the caller provided an explicit instance_ids list, preserve that order.
        # Some loaders (e.g. HF datasets) may return filtered instances in dataset order.
        if instance_ids:
            instances_by_id = {inst.instance_id: inst for inst in instances}
            ordered_instances: List[SWEInstance] = []
            missing_ids: List[str] = []
            for iid in instance_ids:
                inst = instances_by_id.get(iid)
                if inst is None:
                    missing_ids.append(iid)
                else:
                    ordered_instances.append(inst)
            if missing_ids:
                logger.warning(
                    "Some requested instance IDs were not found in the dataset",
                    missing_count=len(missing_ids),
                    missing_ids=missing_ids[:50],
                )
            instances = ordered_instances
        
        logger.info(
            "Loaded instances for batch run",
            total_instances=len(instances),
        )
        
        # Filter completed instances if resuming
        if resume:
            completed_ids = set()
            for instance_dir in self.run_dir.instances_dir.iterdir():
                if instance_dir.is_dir():
                    meta_path = instance_dir / "meta.json"
                    if meta_path.exists():
                        try:
                            meta = InstanceMetadata.model_validate_json(
                                meta_path.read_text()
                            )
                            if meta.status in [
                                InstanceStatus.COMPLETED,
                                InstanceStatus.FAILED,
                                InstanceStatus.TIMEOUT,
                            ]:
                                completed_ids.add(meta.instance_id)
                        except Exception:
                            pass
            
            if completed_ids:
                instances = [
                    inst for inst in instances if inst.instance_id not in completed_ids
                ]
                logger.info(
                    "Filtered completed instances for resume",
                    remaining=len(instances),
                    completed=len(completed_ids),
                )
        
        # Track statistics
        stats = {
            "completed": 0,
            "failed": 0,
            "timeout": 0,
        }
        
        # Run with concurrency control
        semaphore = asyncio.Semaphore(max_concurrency)
        
        async def run_with_semaphore(instance: SWEInstance) -> Dict:
            async with semaphore:
                return await self.run_single_instance(
                    instance,
                    timeout=timeout,
                    model_name_or_path=model_name_or_path,
                    verify_mode=verify_mode,
                    cache_level=cache_level,
                    clean=clean,
                )
        
        # Execute all instances
        tasks = [asyncio.create_task(run_with_semaphore(inst)) for inst in instances]
        results = await asyncio.gather(*tasks)

        for result in results:
            if result["success"]:
                stats["completed"] += 1
            else:
                if result.get("error") == "timeout":
                    stats["timeout"] += 1
                else:
                    stats["failed"] += 1
        
        # Update run metadata
        await update_run_metadata(self.run_dir, stats, finished=True)
        
        logger.info(
            "Batch run completed",
            run_id=self.run_id,
            stats=stats,
        )
        
        return stats


# Convenience functions for CLI
async def run_single_instance(
    instance_id: str,
    run_id: str,
    timeout_per_instance: int = 300,
    api_provider: str = "zgsm",
    model_name_or_path: str = "costrict-swebench-v1",
    verify_mode: str = "local",
    cache_level: str = "env",
    clean: bool = True,
) -> Dict:
    """Run a single instance."""
    orchestrator = SWEOrchestrator(run_id, api_provider=api_provider)
    
    # Load the specific instance
    instances = list(
        SWEInstanceLoader.load(
            source="princeton-nlp/SWE-bench_Verified",
            split="test",
            instance_ids=[instance_id],
        )
    )
    
    if not instances:
        raise ValueError(f"Instance not found: {instance_id}")
    
    return await orchestrator.run_single_instance(
        instances[0],
        timeout=timeout_per_instance,
        model_name_or_path=model_name_or_path,
        verify_mode=verify_mode,
        cache_level=cache_level,
        clean=clean,
    )


async def run_batch(
    dataset: str,
    split: str,
    run_id: str,
    max_concurrency: int,
    timeout_per_instance: int,
    api_provider: str,
    model_name_or_path: str,
    resume: bool,
    instance_ids: Optional[List[str]],
    verify_mode: str = "local",
    cache_level: str = "env",
    clean: bool = True,
) -> Dict[str, int]:
    """Run batch evaluation."""
    orchestrator = SWEOrchestrator(run_id, api_provider=api_provider)
    return await orchestrator.run_batch(
        dataset=dataset,
        split=split,
        max_concurrency=max_concurrency,
        timeout=timeout_per_instance,
        model_name_or_path=model_name_or_path,
        resume=resume,
        instance_ids=instance_ids,
        verify_mode=verify_mode,
        cache_level=cache_level,
        clean=clean,
    )


def export_predictions(
    run_id: str,
    format: str,
    output_path: Optional[str],
    json_mode: str = "dict",
) -> None:
    """Export predictions for a run."""
    run_dir = RunDirectory(run_id)
    predictions_manager = PredictionsManager(run_dir.path)
    
    if format == "jsonl":
        # Export all_preds.jsonl format
        path = predictions_manager.all_preds_jsonl_path
        if not path.exists():
            # Generate from preds.json if needed
            predictions_manager.export_all_formats()
        
        if output_path:
            Path(output_path).write_text(path.read_text())
        else:
            print(path.read_text())
            
    elif format == "json":
        loaded = predictions_manager.load_predictions()
        if not loaded:
            raise FileNotFoundError(f"No predictions found for run: {run_id}")

        if json_mode == "dict":
            payload: object = loaded
        elif json_mode == "list":
            payload = [
                {"instance_id": instance_id, "model_patch": model_patch}
                for instance_id, model_patch in loaded.items()
            ]
        else:
            raise ValueError(f"Unsupported json_mode: {json_mode}")

        text = json.dumps(payload, indent=2)
        if output_path:
            Path(output_path).write_text(text)
        else:
            print(text)
    else:
        raise ValueError(f"Unsupported format: {format}")


def generate_report(run_id: str, output_path: Optional[str]) -> str:
    """Generate evaluation report."""
    run_dir = RunDirectory(run_id)
    meta_path = run_dir.get_metadata_path()
    
    if not meta_path.exists():
        raise FileNotFoundError(f"No run metadata found for: {run_id}")
    
    metadata = json.loads(meta_path.read_text())
    
    # Generate report
    report = f"""# SWE-bench Evaluation Report

## Run Information
- Run ID: {run_id}
- Dataset: {metadata.get('dataset', 'Unknown')}
- Split: {metadata.get('split', 'Unknown')}
- Started: {metadata.get('started_at', 'Unknown')}
- Finished: {metadata.get('finished_at', 'Unknown')}

## Results Summary
- Total Instances: {metadata.get('total_instances', 0)}
- Completed: {metadata.get('completed_instances', 0)}
- Failed: {metadata.get('failed_instances', 0)}
- Timeout: {metadata.get('timeout_instances', 0)}
- Success Rate: {metadata.get('completed_instances', 0) / max(1, metadata.get('total_instances', 1)) * 100:.1f}%

## Configuration
- Max Concurrency: {metadata.get('max_concurrency', 1)}
- Timeout per Instance: {metadata.get('timeout_per_instance', 300)}s
- Model: {metadata.get('model_name_or_path', 'Unknown')}
"""
    
    if output_path:
        Path(output_path).write_text(report)
    
    return report
