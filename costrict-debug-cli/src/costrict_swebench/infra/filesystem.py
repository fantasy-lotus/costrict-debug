"""Filesystem utilities for the orchestrator."""

import asyncio
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import aiofiles
import structlog

from costrict_swebench.domain.models import (
    ExitStatus,
    InstanceMetadata,
    PredictionRecord,
    RunMetadata,
    Trajectory,
)

logger = structlog.get_logger()


class RunDirectory:
    """Manages the directory structure for a run."""
    
    def __init__(self, run_id: str, base_dir: Optional[Path] = None):
        self.run_id = run_id
        self.base_dir = base_dir or Path.cwd() / ".runs"
        self.run_dir = self.base_dir / run_id
        self.instances_dir = self.run_dir / "instances"
        self.cases_dir = self.run_dir / "cases"
        self.path = self.run_dir  # Add path property for compatibility
        
    def ensure_structure(self) -> None:
        """Create the directory structure if it doesn't exist."""
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.instances_dir.mkdir(parents=True, exist_ok=True)
        self.cases_dir.mkdir(parents=True, exist_ok=True)
        
    def get_instance_dir(self, instance_id: str) -> Path:
        """Get the directory for a specific instance."""
        return self.instances_dir / instance_id
    
    def ensure_instance_dir(self, instance_id: str) -> Path:
        """Ensure instance directory exists and return it."""
        instance_dir = self.get_instance_dir(instance_id)
        instance_dir.mkdir(parents=True, exist_ok=True)
        return instance_dir
    
    def get_metadata_path(self) -> Path:
        """Get path to run metadata file."""
        return self.run_dir / "summary.json"
    
    def get_predictions_path(self, format: str = "json") -> Path:
        """Get path to predictions file."""
        if format == "jsonl":
            return self.run_dir / "all_preds.jsonl"
        return self.run_dir / "preds.json"
    
    def get_instance_metadata_path(self, instance_id: str) -> Path:
        """Get path to instance metadata file."""
        return self.get_instance_dir(instance_id) / "meta.json"
    
    def get_patch_path(self, instance_id: str) -> Path:
        """Get path to patch file."""
        return self.get_instance_dir(instance_id) / "patch.diff"
    
    def get_trajectory_path(self, instance_id: str) -> Path:
        """Get path to trajectory file."""
        return self.get_instance_dir(instance_id) / "traj.json"
    
    def get_test_output_path(self, instance_id: str) -> Path:
        """Get path to test output file."""
        return self.get_instance_dir(instance_id) / "test_output.txt"
    
    def get_agent_io_path(self, instance_id: str) -> Path:
        """Get path to agent I/O log file."""
        return self.get_instance_dir(instance_id) / "agent_io.jsonl"


class PredictionsWriter:
    """Thread-safe predictions writer."""
    
    def __init__(self, run_dir: RunDirectory):
        self.run_dir = run_dir
        self._lock_file = run_dir.run_dir / ".preds.lock"
        
    async def write_prediction(
        self,
        instance_id: str,
        patch: Optional[str],
        model_name_or_path: str,
    ) -> None:
        """Write a single prediction atomically."""
        # Simple file-based locking
        try:
            # Acquire lock
            while self._lock_file.exists():
                await asyncio.sleep(0.1)
            self._lock_file.write_text("locked")
            
            # Read existing predictions
            preds_path = self.run_dir.get_predictions_path("json")
            if preds_path.exists():
                data = json.loads(preds_path.read_text())
            else:
                data = {}
            
            # Update prediction
            data[instance_id] = {
                "model_patch": patch,
                "model_name_or_path": model_name_or_path,
            }
            
            # Write back
            preds_path.write_text(json.dumps(data, indent=2))
            
            # Also write to JSONL
            jsonl_path = self.run_dir.get_predictions_path("jsonl")
            jsonl_record = json.dumps({
                "instance_id": instance_id,
                "model_patch": patch,
                "model_name_or_path": model_name_or_path,
            })
            
            # Read existing JSONL and rewrite (simple approach for now)
            if jsonl_path.exists():
                lines = jsonl_path.read_text().strip().split("\n")
                # Remove existing line for this instance if present
                lines = [line for line in lines if instance_id not in line]
            else:
                lines = []
            
            lines.append(jsonl_record)
            jsonl_path.write_text("\n".join(lines) + "\n")
            
        finally:
            # Release lock
            if self._lock_file.exists():
                self._lock_file.unlink()
    
    def export_jsonl(self, output_path: Optional[Path] = None) -> Path:
        """Export predictions in JSONL format."""
        jsonl_path = self.run_dir.get_predictions_path("jsonl")
        if output_path:
            output_path.write_text(jsonl_path.read_text())
            return output_path
        return jsonl_path
    
    def export_json(self, mode: str = "dict", output_path: Optional[Path] = None) -> Path:
        """Export predictions in JSON format."""
        json_path = self.run_dir.get_predictions_path("json")
        data = json.loads(json_path.read_text())
        
        if mode == "list":
            # Convert dict to list
            predictions = [
                {
                    "instance_id": instance_id,
                    **prediction,
                }
                for instance_id, prediction in data.items()
            ]
            output_data = predictions
        else:
            output_data = data
        
        if output_path:
            output_path.write_text(json.dumps(output_data, indent=2))
            return output_path
        
        # Return temporary file path
        temp_path = json_path.parent / f"preds_{mode}.json"
        temp_path.write_text(json.dumps(output_data, indent=2))
        return temp_path


async def save_instance_metadata(
    run_dir: RunDirectory,
    metadata: InstanceMetadata,
) -> None:
    """Save instance metadata."""
    meta_path = run_dir.get_instance_metadata_path(metadata.instance_id)
    run_dir.ensure_instance_dir(metadata.instance_id)
    
    async with aiofiles.open(meta_path, "w") as f:
        await f.write(metadata.model_dump_json(indent=2))


async def save_trajectory(
    run_dir: RunDirectory,
    instance_id: str,
    trajectory: Trajectory,
) -> None:
    """Save trajectory ensuring finally semantics."""
    traj_path = run_dir.get_trajectory_path(instance_id)
    
    async with aiofiles.open(traj_path, "w") as f:
        await f.write(trajectory.model_dump_json(indent=2))
    
    logger.info("Trajectory saved", instance_id=instance_id, path=str(traj_path))


async def save_patch(
    run_dir: RunDirectory,
    instance_id: str,
    patch: Optional[str],
) -> None:
    """Save patch file."""
    if patch:
        patch_path = run_dir.get_patch_path(instance_id)
        run_dir.ensure_instance_dir(instance_id)
        
        async with aiofiles.open(patch_path, "w") as f:
            await f.write(patch)


async def save_instance_text_log(
    run_dir: RunDirectory,
    instance_id: str,
    filename: str,
    content: str,
) -> None:
    instance_dir = run_dir.ensure_instance_dir(instance_id)
    path = instance_dir / filename
    async with aiofiles.open(path, "w") as f:
        await f.write(content)


async def append_instance_text_log(
    run_dir: RunDirectory,
    instance_id: str,
    filename: str,
    content: str,
) -> None:
    instance_dir = run_dir.ensure_instance_dir(instance_id)
    path = instance_dir / filename
    async with aiofiles.open(path, "a") as f:
        await f.write(content)


async def save_instance_json(
    run_dir: RunDirectory,
    instance_id: str,
    filename: str,
    data: Any,
) -> None:
    instance_dir = run_dir.ensure_instance_dir(instance_id)
    path = instance_dir / filename
    async with aiofiles.open(path, "w") as f:
        await f.write(json.dumps(data, indent=2, ensure_ascii=False))


async def update_run_metadata(
    run_dir: RunDirectory,
    stats: Dict[str, int],
    finished: bool = False,
) -> None:
    """Update run metadata with current stats."""
    meta_path = run_dir.get_metadata_path()
    
    if meta_path.exists():
        metadata = RunMetadata.model_validate_json(meta_path.read_text())
    else:
        metadata = RunMetadata(
            run_id=run_dir.run_id,
        )
    
    metadata.completed_instances = stats.get("completed", 0)
    metadata.failed_instances = stats.get("failed", 0)
    metadata.timeout_instances = stats.get("timeout", 0)
    
    if finished:
        metadata.finished_at = datetime.utcnow()
    
    meta_path.write_text(metadata.model_dump_json(indent=2))
