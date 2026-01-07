"""Integration with CoStrict runner via subprocess."""

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Optional

import structlog

from costrict_swebench.domain.models import SWEInstance, Trajectory, TrajectoryInfo

logger = structlog.get_logger()


class CoStrictRunner:
    """Manages CoStrict runner execution via subprocess."""
    
    def __init__(
        self,
        workspace_root: Path,
        evals_package_path: Optional[Path] = None,
    ):
        self.workspace_root = workspace_root
        # Default to packages/evals relative to workspace root
        self.evals_path = evals_package_path or workspace_root / "packages" / "evals"
        
    def prepare_prompt(self, instance: SWEInstance) -> str:
        """Prepare the prompt for CoStrict agent."""
        hint_block = ""
        if getattr(instance, "hints_text", None):
            hint_block = f"\n\nHints:\n{instance.hints_text}"  # type: ignore[attr-defined]

        prompt = (
            f"Repository: {instance.repo}\n"
            f"Base commit: {instance.base_commit}\n\n"
            f"Problem Statement:\n{instance.problem_statement}{hint_block}\n\n"
            "FAIL_TO_PASS tests that must pass:\n"
            f"{chr(10).join(f'- {test}' for test in instance.FAIL_TO_PASS)}\n\n"
            "PASS_TO_PASS tests that must not fail:\n"
            f"{chr(10).join(f'- {test}' for test in instance.PASS_TO_PASS)}\n"
        )
        return prompt
    
    def run_costrict_task(
        self,
        instance: SWEInstance,
        workspace_dir: Path,
        timeout: int = 300,
        mode: str = "swebench",
        api_provider: str = "zgsm",
    ) -> Dict:
        """Run CoStrict on the given instance using the TS CLI."""
        logger.info(
            "Starting CoStrict task",
            instance_id=instance.instance_id,
            workspace_dir=str(workspace_dir),
        )
        
        # Prepare prompt file outside the git workspace to avoid polluting `git diff`
        prompt = self.prepare_prompt(instance)
        prompt_file = workspace_dir.parent / "prompt.md"
        prompt_file.write_text(prompt)
        
        pnpm_path = shutil.which("pnpm")
        if pnpm_path is not None:
            pnpm_prefix = [pnpm_path]
        else:
            corepack_path = shutil.which("corepack")
            if corepack_path is not None:
                pnpm_prefix = [corepack_path, "pnpm"]
            else:
                raise RuntimeError(
                    "pnpm is not available on PATH. Install pnpm (recommended) or enable corepack. "
                    "For example: `corepack enable` then `corepack prepare pnpm@latest --activate`, "
                    "or install via your package manager (e.g. `brew install pnpm`)."
                )

        node_path = shutil.which("node")
        if node_path is None:
            raise RuntimeError(
                "Node.js is required to run pnpm/tsx. Install Node (e.g. `brew install node`) "
                "and ensure `node` is on PATH."
            )

        cmd = pnpm_prefix + [
            "--filter",
            "@roo-code/evals",
            "exec",
            "tsx",
            "src/cli/index.ts",
            "--instance-id",
            instance.instance_id,
            "--workspace-path",
            str(workspace_dir),
            "--prompt-file",
            str(prompt_file),
            "--mode",
            mode,
            "--api-provider",
            api_provider,
            "--timeout-ms",
            str(int(timeout * 1000)),
        ]
        
        env = os.environ.copy()
        if "OPENROUTER_API_KEY" in os.environ:
            env["OPENROUTER_API_KEY"] = os.environ["OPENROUTER_API_KEY"]
        if "ROO_CODE_CLOUD_TOKEN" in os.environ:
            env["ROO_CODE_CLOUD_TOKEN"] = os.environ["ROO_CODE_CLOUD_TOKEN"]

        repo_root = self.workspace_root
        while not (repo_root / "pnpm-workspace.yaml").exists() and repo_root != repo_root.parent:
            repo_root = repo_root.parent
        env["ROO_CODE_EXTENSION_DEV_PATH"] = str(repo_root / "src")
        
        try:
            logger.info(
                "Executing CoStrict task via TS CLI",
                instance_id=instance.instance_id,
                command=" ".join(cmd),
                timeout=timeout,
            )
            
            # Run the command and capture output
            result = subprocess.run(
                cmd,
                cwd=self.workspace_root,
                env=env,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            
            if result.returncode != 0:
                try:
                    debug_dir = workspace_dir.parent
                    (debug_dir / "ts_cli.stdout.txt").write_text(result.stdout or "")
                    (debug_dir / "ts_cli.stderr.txt").write_text(result.stderr or "")
                except Exception:
                    pass

                logger.error(
                    "CoStrict task failed",
                    instance_id=instance.instance_id,
                    returncode=result.returncode,
                    stderr=result.stderr,
                    stdout=result.stdout,
                )

                err = result.stderr.strip() or result.stdout.strip()
                if not err:
                    err = f"TS CLI failed with exit code {result.returncode} (no output captured)"
                return {
                    "success": False,
                    "error": f"TS CLI failed with exit code {result.returncode}: {err}",
                }
            
            # Parse the JSON output from the TS CLI
            try:
                output = None
                stdout = result.stdout or ""
                marker = "__COSTRICT_RESULT__"
                if marker in stdout:
                    payload = stdout.split(marker)[-1].strip()
                    output = json.loads(payload)
                else:
                    candidates = [i for i, ch in enumerate(stdout) if ch == "{"]
                    for start in reversed(candidates):
                        try:
                            output = json.loads(stdout[start:])
                            break
                        except json.JSONDecodeError:
                            continue
                    if output is None:
                        output = json.loads(stdout)
                patch = output.get("patch", "")
                trajectory_data = output.get("trajectory")

                def _normalize_message_content(content) -> str:
                    if content is None:
                        return ""
                    if isinstance(content, str):
                        return content
                    if isinstance(content, dict):
                        block_type = content.get("type")
                        if block_type == "text" and isinstance(content.get("text"), str):
                            return str(content["text"])
                        return json.dumps(content, ensure_ascii=False)
                    if isinstance(content, list):
                        parts = []
                        for block in content:
                            if isinstance(block, str):
                                parts.append(block)
                                continue
                            if isinstance(block, dict):
                                block_type = block.get("type")
                                if block_type == "text" and isinstance(block.get("text"), str):
                                    parts.append(block.get("text"))
                                elif block_type == "tool_use":
                                    name = block.get("name")
                                    parts.append(f"[tool_use]{' ' + name if isinstance(name, str) else ''}")
                                elif block_type == "tool_result":
                                    parts.append("[tool_result]")
                                else:
                                    parts.append(json.dumps(block, ensure_ascii=False))
                                continue
                            parts.append(str(block))
                        return "\n".join([p for p in parts if p])
                    return str(content)
                
                # Convert trajectory data to Trajectory model
                trajectory = None
                if trajectory_data:
                    # Map the conversation history to our Trajectory format
                    messages = []
                    if isinstance(trajectory_data, list):
                        for msg in trajectory_data:
                            if isinstance(msg, dict) and "role" in msg and "content" in msg:
                                messages.append({
                                    "role": msg["role"],
                                    "content": _normalize_message_content(msg["content"]),
                                    "timestamp": msg.get("timestamp", "2024-01-01T00:00:00Z"),
                                })
                    
                    trajectory = Trajectory(
                        info=TrajectoryInfo(
                            exit_status="success" if patch else "failed",
                            result={
                                "patch_generated": bool(patch),
                                "patch_size": len(patch),
                            },
                        ),
                        messages=messages,
                    )
                
                # Save trajectory and patch to workspace
                if trajectory:
                    trajectory_file = workspace_dir / "trajectory.json"
                    trajectory_file.write_text(trajectory.model_dump_json(indent=2))
                
                if patch:
                    patch_file = workspace_dir / "patch.diff"
                    patch_file.write_text(patch)
                
                logger.info(
                    "CoStrict task completed",
                    instance_id=instance.instance_id,
                    patch_size=len(patch),
                    has_trajectory=bool(trajectory),
                )
                
                return {
                    "success": bool(patch),
                    "patch": patch,
                    "trajectory": trajectory,
                }
                
            except json.JSONDecodeError as e:
                try:
                    debug_dir = workspace_dir.parent
                    (debug_dir / "ts_cli.stdout.txt").write_text(result.stdout or "")
                    (debug_dir / "ts_cli.stderr.txt").write_text(result.stderr or "")
                except Exception:
                    pass

                logger.error(
                    "Failed to parse TS CLI output",
                    instance_id=instance.instance_id,
                    error=str(e),
                    stdout=result.stdout[:500],  # First 500 chars
                )
                return {
                    "success": False,
                    "error": f"Failed to parse JSON output: {e}",
                }
                
        except subprocess.TimeoutExpired:
            logger.error(
                "CoStrict task timed out",
                instance_id=instance.instance_id,
                timeout=timeout,
            )
            return {
                "success": False,
                "error": f"Task timed out after {timeout} seconds",
            }
        except Exception as e:
            logger.error(
                "Unexpected error running CoStrict task",
                instance_id=instance.instance_id,
                error=str(e),
            )
            return {
                "success": False,
                "error": f"Unexpected error: {e}",
            }
    
    def create_and_run_task(
        self,
        instance: SWEInstance,
        workspace_dir: Path,
        timeout: int = 300,
        mode: str = "swebench",
    ) -> Dict:
        """Create a task in the database and run it."""
        # This would integrate with the existing task management system
        # For now, delegate to run_costrict_task
        return self.run_costrict_task(instance, workspace_dir, timeout, mode)
