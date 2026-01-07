"""Type definitions for the orchestrator."""

from typing import Any, Dict, List, Optional, TypedDict

from .models import SWEInstance, Trajectory


class TestResult(TypedDict):
    """Result of running tests."""
    exit_code: int
    stdout: str
    stderr: str
    passed: bool


class InstanceExecutionResult(TypedDict):
    """Result of executing an instance."""
    instance_id: str
    success: bool
    patch: Optional[str]
    trajectory: Trajectory
    test_results: Optional[TestResult]
    error: Optional[str]


class RunConfig(TypedDict, total=False):
    """Configuration for a run."""
    max_concurrency: int
    timeout_per_instance: int
    model_name_or_path: str
    resume: bool
    instance_ids: Optional[List[str]]
