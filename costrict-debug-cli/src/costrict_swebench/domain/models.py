"""Domain models for SWE-bench evaluation."""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class InstanceStatus(str, Enum):
    """Status of an instance execution."""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    TIMEOUT = "timeout"


class ExitStatus(str, Enum):
    """Exit status for trajectory info."""
    SUCCESS = "success"
    FAILED = "failed"
    TIMEOUT = "timeout"
    ERROR = "error"


class SWEInstance(BaseModel):
    """SWE-bench instance model."""
    instance_id: str
    repo: str
    base_commit: str
    problem_statement: str
    hints_text: Optional[str] = None
    created_at: Optional[datetime] = None
    version: Optional[str] = None
    FAIL_TO_PASS: List[str] = Field(default_factory=list)
    PASS_TO_PASS: List[str] = Field(default_factory=list)
    environment_setup_commit: Optional[str] = None
    patch: Optional[str] = None
    test_patch: Optional[str] = None
    
    # Optional fields from SWE-bench Verified
    image_name: Optional[str] = None
    env_startup_command: Optional[str] = None


class PredictionRecord(BaseModel):
    """Single prediction record for JSONL export."""
    instance_id: str
    model_patch: Optional[str] = None
    model_name_or_path: str


class PredictionsDict(BaseModel):
    """Predictions in dict format for sb-cli."""
    predictions: Dict[str, PredictionRecord] = Field(default_factory=dict)


class TrajectoryInfo(BaseModel):
    """Info section of trajectory."""
    exit_status: ExitStatus
    submission: Optional[Dict[str, Any]] = None
    result: Optional[Dict[str, Any]] = None
    model_stats: Optional[Dict[str, Any]] = None
    config: Optional[Dict[str, Any]] = None


class TrajectoryMessage(BaseModel):
    """Single message in trajectory."""
    role: str
    content: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class Trajectory(BaseModel):
    """Execution trajectory for an instance."""
    trajectory_format: str = "costrict-swebench-1"
    messages: List[TrajectoryMessage] = Field(default_factory=list)
    info: TrajectoryInfo


class InstanceMetadata(BaseModel):
    """Metadata saved with each instance."""
    instance_id: str
    run_id: str
    started_at: datetime
    finished_at: Optional[datetime] = None
    status: InstanceStatus = InstanceStatus.PENDING
    
    # Image resolution info
    image_name_resolved: str
    image_name_source: str  # "instance.image_name" | "derived_from_instance_id"
    
    # Execution stats
    total_duration_seconds: Optional[float] = None
    exit_status: Optional[ExitStatus] = None
    
    # Error info if failed
    error_message: Optional[str] = None
    error_type: Optional[str] = None


class RunMetadata(BaseModel):
    """Metadata for a run."""
    run_id: str
    dataset: Optional[str] = None
    split: Optional[str] = None
    started_at: datetime = Field(default_factory=datetime.utcnow)
    finished_at: Optional[datetime] = None
    total_instances: int = 0
    completed_instances: int = 0
    failed_instances: int = 0
    timeout_instances: int = 0
    
    # Configuration
    max_concurrency: int = 1
    timeout_per_instance: int = 300  # seconds
    
    # Model configuration
    model_name_or_path: str = "costrict-swebench-v1"
    
    # Optional filters
    instance_ids: Optional[List[str]] = None
