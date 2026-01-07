"""Data loader for SWE-bench datasets."""

import json
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Union

import structlog
from datasets import Dataset, load_dataset

from costrict_swebench.domain.models import SWEInstance

logger = structlog.get_logger()


class SWEInstanceLoader:
    """Loads SWE-bench instances from various sources."""

    @staticmethod
    def _normalize_list_field(value: object) -> List[str]:
        if value is None:
            return []
        if isinstance(value, list):
            return [str(x) for x in value]
        if isinstance(value, str):
            s = value.strip()
            if not s:
                return []
            try:
                parsed = json.loads(s)
            except Exception:
                return [value]
            if isinstance(parsed, list):
                return [str(x) for x in parsed]
            if parsed is None:
                return []
            return [str(parsed)]
        return [str(value)]
    
    @staticmethod
    def from_huggingface(
        dataset_name: str = "princeton-nlp/SWE-bench_Verified",
        split: str = "test",
        instance_ids: Optional[List[str]] = None,
    ) -> Iterable[SWEInstance]:
        """Load instances from HuggingFace datasets."""
        logger.info(
            "Loading dataset from HuggingFace",
            dataset_name=dataset_name,
            split=split,
        )
        
        try:
            dataset = load_dataset(dataset_name, split=split)
            logger.info(
                "Dataset loaded",
                total_instances=len(dataset),
            )
            
            # Filter by instance IDs if provided
            if instance_ids:
                dataset = dataset.filter(
                    lambda example: example["instance_id"] in instance_ids
                )
                logger.info(
                    "Filtered by instance IDs",
                    filtered_count=len(dataset),
                )
            
            for example in dataset:
                if "FAIL_TO_PASS" in example:
                    example["FAIL_TO_PASS"] = SWEInstanceLoader._normalize_list_field(
                        example.get("FAIL_TO_PASS")
                    )
                if "PASS_TO_PASS" in example:
                    example["PASS_TO_PASS"] = SWEInstanceLoader._normalize_list_field(
                        example.get("PASS_TO_PASS")
                    )
                yield SWEInstance(**example)
                
        except Exception as e:
            logger.error(
                "Failed to load dataset from HuggingFace",
                dataset_name=dataset_name,
                split=split,
                error=str(e),
                exc_info=True,
            )
            raise
    
    @staticmethod
    def from_json_file(
        file_path: Union[str, Path],
        instance_ids: Optional[List[str]] = None,
    ) -> Iterable[SWEInstance]:
        """Load instances from a JSON file (list or dict format)."""
        file_path = Path(file_path)
        logger.info(
            "Loading instances from JSON file",
            file_path=str(file_path),
        )
        
        if not file_path.exists():
            raise FileNotFoundError(f"Data file not found: {file_path}")
        
        with open(file_path, "r") as f:
            data = json.load(f)
        
        # Handle different JSON formats
        if isinstance(data, list):
            instances = data
        elif isinstance(data, dict):
            # Could be {"instances": [...]} or {instance_id: {...}}
            if "instances" in data:
                instances = data["instances"]
            else:
                instances = list(data.values())
        else:
            raise ValueError(f"Unexpected JSON format in {file_path}")
        
        logger.info(
            "Loaded instances from JSON",
            total_instances=len(instances),
        )
        
        # Filter and validate
        for instance_data in instances:
            instance = SWEInstance(**instance_data)
            if not instance_ids or instance.instance_id in instance_ids:
                yield instance
    
    @staticmethod
    def from_jsonl_file(
        file_path: Union[str, Path],
        instance_ids: Optional[List[str]] = None,
    ) -> Iterable[SWEInstance]:
        """Load instances from a JSONL file."""
        file_path = Path(file_path)
        logger.info(
            "Loading instances from JSONL file",
            file_path=str(file_path),
        )
        
        if not file_path.exists():
            raise FileNotFoundError(f"Data file not found: {file_path}")
        
        count = 0
        with open(file_path, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                
                try:
                    instance_data = json.loads(line)
                    instance = SWEInstance(**instance_data)
                    
                    if not instance_ids or instance.instance_id in instance_ids:
                        count += 1
                        yield instance
                        
                except Exception as e:
                    logger.warning(
                        "Failed to parse instance line",
                        line_number=count + 1,
                        error=str(e),
                    )
                    continue
        
        logger.info(
            "Loaded instances from JSONL",
            loaded_count=count,
        )
    
    @classmethod
    def load(
        cls,
        source: Union[str, Path],
        split: Optional[str] = None,
        instance_ids: Optional[List[str]] = None,
    ) -> Iterable[SWEInstance]:
        """
        Load instances from various sources.
        
        Args:
            source: Dataset name (for HF) or file path
            split: Dataset split (for HF datasets)
            instance_ids: Optional list of instance IDs to filter
            
        Returns:
            Iterable of SWEInstance objects
        """
        source_str = str(source)
        
        # Check if it's a HuggingFace dataset name
        if "/" in source_str and not Path(source_str).exists():
            return cls.from_huggingface(
                dataset_name=source_str,
                split=split or "test",
                instance_ids=instance_ids,
            )
        
        # Check if it's a local file
        path = Path(source_str)
        if path.exists():
            if path.suffix == ".jsonl":
                return cls.from_jsonl_file(path, instance_ids)
            elif path.suffix == ".json":
                return cls.from_json_file(path, instance_ids)
            else:
                raise ValueError(f"Unsupported file format: {path.suffix}")
        
        raise ValueError(f"Cannot determine source type for: {source}")


def resolve_image_name(instance: SWEInstance) -> str:
    """
    Resolve Docker image name for a SWE-bench instance.
    
    Follows the rules from swebench-image-name-rule.md:
    1. If instance has image_name, use it
    2. Otherwise, construct from instance_id
    
    Args:
        instance: SWE instance
        
    Returns:
        Docker image name
    """
    if instance.image_name:
        logger.debug(
            "Using instance image_name",
            instance_id=instance.instance_id,
            image_name=instance.image_name,
        )
        return instance.image_name
    
    # Construct from instance_id
    image_id = instance.instance_id.replace("__", "_1776_")
    image_name = f"docker.io/swebench/sweb.eval.x86_64.{image_id}:latest".lower()
    
    logger.debug(
        "Constructed image name from instance_id",
        instance_id=instance.instance_id,
        image_name=image_name,
    )
    
    return image_name
