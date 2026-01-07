import json
import os
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, cast
from dataclasses import dataclass

import fcntl
from contextlib import contextmanager

logger = logging.getLogger(__name__)


@dataclass
class Prediction:
    """A single prediction for an instance."""
    instance_id: str
    model_patch: str
    model_name_or_path: str = "costrict-swebench-v1"
    metadata: Optional[Dict[str, Any]] = None


class PredictionsManager:
    """Manages predictions export with concurrent-safe writing."""
    
    def __init__(self, output_dir: Path):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        # File paths
        self.preds_json_path = self.output_dir / "preds.json"
        self.predictions_jsonl_path = self.output_dir / "predictions.jsonl"
        self.all_preds_jsonl_path = self.output_dir / "all_preds.jsonl"
        self.sb_preds_json_path = self.output_dir / "sb_preds.json"

    @contextmanager
    def _exclusive_lock(self, file_path: Path):
        lock_file = file_path.with_suffix(file_path.suffix + ".lock")
        lock_fd = os.open(lock_file, os.O_CREAT | os.O_WRONLY | os.O_TRUNC)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            os.close(lock_fd)
            try:
                lock_file.unlink()
            except FileNotFoundError:
                pass

    def _atomic_write_json(self, file_path: Path, obj: Any) -> None:
        tmp_path = file_path.with_suffix(file_path.suffix + ".tmp")
        try:
            with open(tmp_path, "w") as f:
                json.dump(obj, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            tmp_path.replace(file_path)
        finally:
            try:
                tmp_path.unlink()
            except FileNotFoundError:
                pass

    def _atomic_write_text(self, file_path: Path, text: str) -> None:
        tmp_path = file_path.with_suffix(file_path.suffix + ".tmp")
        try:
            with open(tmp_path, "w") as f:
                f.write(text)
                f.flush()
                os.fsync(f.fileno())
            tmp_path.replace(file_path)
        finally:
            try:
                tmp_path.unlink()
            except FileNotFoundError:
                pass
    
    def write_prediction(self, prediction: Prediction) -> None:
        logger.info("Writing prediction", extra={"instance_id": prediction.instance_id})

        patch = prediction.model_patch or ""
        if patch and not patch.endswith("\n"):
            patch += "\n"

        with self._exclusive_lock(self.preds_json_path):
            predictions: Dict[str, str] = {}
            if self.preds_json_path.exists():
                try:
                    with open(self.preds_json_path, "r") as f:
                        predictions = cast(Dict[str, str], json.load(f))
                except (json.JSONDecodeError, FileNotFoundError):
                    predictions = {}

            predictions[prediction.instance_id] = patch
            self._atomic_write_json(self.preds_json_path, predictions)

        # Also export a harness-friendly predictions.jsonl (stable rewrite).
        # JSONL avoids duplicate-instance ambiguity in downstream tooling.
        with self._exclusive_lock(self.predictions_jsonl_path):
            rows: List[str] = []
            for instance_id, model_patch in predictions.items():
                # Enforce newline-terminated patch, as git apply can warn when truncated
                mp = model_patch
                if mp and not mp.endswith("\n"):
                    mp += "\n"
                row = {
                    "instance_id": instance_id,
                    "model_name_or_path": prediction.model_name_or_path,
                    "model_patch": mp,
                }
                rows.append(json.dumps(row, ensure_ascii=False))
            self._atomic_write_text(self.predictions_jsonl_path, "\n".join(rows) + ("\n" if rows else ""))

        logger.info("Successfully wrote prediction", extra={"instance_id": prediction.instance_id})
    
    def write_all_preds_jsonl(self, predictions: List[Prediction]) -> None:
        logger.info("Writing all_preds.jsonl", extra={"count": len(predictions)})
        lines: List[str] = []
        for pred in predictions:
            line: Dict[str, Any] = {
                "instance_id": pred.instance_id,
                "model_patch": pred.model_patch,
            }
            if pred.metadata is not None:
                line["metadata"] = pred.metadata
            lines.append(json.dumps(line))

        with self._exclusive_lock(self.all_preds_jsonl_path):
            self._atomic_write_text(self.all_preds_jsonl_path, "\n".join(lines) + "\n")

        logger.info("Successfully wrote all_preds.jsonl", extra={"count": len(predictions)})
    
    def write_sb_preds_json(self, predictions: List[Prediction]) -> None:
        logger.info("Writing sb_preds.json", extra={"count": len(predictions)})
        sb_predictions: List[Dict[str, Any]] = []
        for pred in predictions:
            sb_pred: Dict[str, Any] = {
                "instance_id": pred.instance_id,
                "model_patch": pred.model_patch,
            }
            if pred.metadata is not None:
                sb_pred["metadata"] = pred.metadata
            sb_predictions.append(sb_pred)

        with self._exclusive_lock(self.sb_preds_json_path):
            self._atomic_write_json(self.sb_preds_json_path, sb_predictions)

        logger.info("Successfully wrote sb_preds.json", extra={"count": len(predictions)})
    
    def load_predictions(self) -> Dict[str, str]:
        if not self.preds_json_path.exists():
            return {}
        with self._exclusive_lock(self.preds_json_path):
            try:
                with open(self.preds_json_path, "r") as f:
                    data = json.load(f)
                    out: Dict[str, str] = {}
                    for k, v in data.items():
                        if isinstance(k, str) and isinstance(v, str):
                            out[k] = v
                    return out
            except (json.JSONDecodeError, FileNotFoundError):
                return {}
    
    def export_all_formats(self, predictions: Optional[List[Prediction]] = None) -> None:
        """Export predictions in all required formats."""
        if predictions is None:
            # Load from preds.json
            loaded = self.load_predictions()
            predictions = [
                Prediction(instance_id=instance_id, model_patch=patch)
                for instance_id, patch in loaded.items()
            ]
        
        # Export in all formats
        self.write_all_preds_jsonl(predictions)
        self.write_sb_preds_json(predictions)

        logger.info("Exported all prediction formats", extra={"count": len(predictions)})
    
    def get_stats(self) -> Dict[str, Any]:
        """Get statistics about predictions."""
        predictions = self.load_predictions()
        
        stats = {
            "total_predictions": len(predictions),
            "preds_json_exists": self.preds_json_path.exists(),
            "all_preds_jsonl_exists": self.all_preds_jsonl_path.exists(),
            "sb_preds_json_exists": self.sb_preds_json_path.exists(),
        }
        
        if predictions:
            # Calculate patch sizes
            patch_sizes = [len(patch) for patch in predictions.values()]
            stats.update({
                "avg_patch_size": sum(patch_sizes) / len(patch_sizes),
                "min_patch_size": min(patch_sizes),
                "max_patch_size": max(patch_sizes),
            })
        
        return stats
