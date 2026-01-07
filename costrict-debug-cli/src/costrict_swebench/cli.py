"""CLI entry point for CoStrict SWE-bench orchestrator."""

import asyncio
import logging
import os
from pathlib import Path
from typing import Optional

import structlog
import typer
from dotenv import load_dotenv
from rich.console import Console
from rich.logging import RichHandler

from costrict_swebench.domain.models import RunMetadata
from costrict_swebench.orchestration.runner import (
    export_predictions,
    generate_report,
    run_batch as run_batch_orchestrator,
    run_single_instance,
)

# Load environment variables
load_dotenv()

log_level_name = str(os.environ.get("COSTRICT_LOG_LEVEL", "INFO")).upper()
log_level = getattr(logging, log_level_name, logging.INFO)
logging.basicConfig(
    level=log_level,
    handlers=[RichHandler()],
)

# Setup structured logging
structlog.configure(
    processors=[
        structlog.stdlib.filter_by_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
        structlog.processors.JSONRenderer(),
    ],
    context_class=dict,
    logger_factory=structlog.stdlib.LoggerFactory(),
    wrapper_class=structlog.stdlib.BoundLogger,
    cache_logger_on_first_use=True,
)

logger = structlog.get_logger()
console = Console()

app = typer.Typer(
    name="costrict-swebench",
    help="CoStrict SWE-bench Verified evaluation orchestrator",
    no_args_is_help=True,
)


@app.command()
def run_instance(
    instance_id: str = typer.Option(..., "--instance-id", help="SWE-bench instance ID"),
    run_id: str = typer.Option(..., "--run-id", help="Unique identifier for this run"),
    timeout: Optional[int] = typer.Option(
        300, "--timeout", help="Timeout in seconds per instance"
    ),
    api_provider: str = typer.Option(
        "zgsm", "--api-provider", help="API provider for the agent (e.g. zgsm, openrouter, zai)"
    ),
    model_name: Optional[str] = typer.Option(
        "costrict-swebench-v1", "--model-name", help="Model name for predictions"
    ),
    verify_mode: str = typer.Option(
        "local",
        "--verify-mode",
        help="Verification mode: local (nodeid tests) or official (swebench.harness.run_evaluation)",
    ),
    cache_level: str = typer.Option(
        "env",
        "--cache-level",
        help="Official harness cache level: none/base/env/instance",
    ),
    clean: bool = typer.Option(
        True,
        "--clean/--no-clean",
        help="Official harness cleanup (flag): use --clean or --no-clean (do not pass True/False)",
    ),
) -> None:
    """Run a single SWE-bench instance."""
    try:
        logger.info(
            "Starting single instance run",
            instance_id=instance_id,
            run_id=run_id,
            timeout=timeout,
            model_name=model_name,
        )
        
        result = asyncio.run(run_single_instance(
            instance_id=instance_id,
            run_id=run_id,
            timeout_per_instance=timeout or 300,
            api_provider=api_provider,
            model_name_or_path=model_name or "costrict-swebench-v1",
            verify_mode=verify_mode,
            cache_level=cache_level,
            clean=clean,
        ))
        
        if result["success"]:
            console.print(f"✅ Instance {instance_id} completed successfully")
            console.print(f"📁 Results saved to: .runs/{run_id}/instances/{instance_id}/")
        else:
            console.print(f"❌ Instance {instance_id} failed: {result.get('error', 'Unknown error')}")
            raise typer.Exit(1)

    except KeyboardInterrupt:
        logger.warning(
            "Single instance run interrupted by user",
            instance_id=instance_id,
            run_id=run_id,
        )
        console.print("Aborted.")
        raise typer.Exit(130)
            
    except Exception as e:
        logger.error(
            "Single instance run failed",
            instance_id=instance_id,
            run_id=run_id,
            error=str(e),
            exc_info=True,
        )
        console.print(f"❌ Error: {e}")
        raise typer.Exit(1)


@app.command()
def run_batch(
    dataset: str = typer.Option(
        "princeton-nlp/SWE-bench_Verified", "--dataset", help="Dataset name"
    ),
    split: str = typer.Option("test", "--split", help="Dataset split"),
    run_id: str = typer.Option(..., "--run-id", help="Unique identifier for this run"),
    max_concurrency: int = typer.Option(
        1, "--max-concurrency", help="Maximum concurrent instances (default: 1 for serial execution to save storage)"
    ),
    timeout: int = typer.Option(
        300, "--timeout", help="Timeout in seconds per instance"
    ),
    api_provider: str = typer.Option(
        "zgsm", "--api-provider", help="API provider for the agent (e.g. zgsm, openrouter)"
    ),
    model_name: Optional[str] = typer.Option(
        "costrict-swebench-v1", "--model-name", help="Model name for predictions"
    ),
    resume: bool = typer.Option(
        False, "--resume", help="Resume from previous run (skip completed instances)"
    ),
    instance_filter: Optional[str] = typer.Option(
        None, "--instance-filter", help="Comma-separated list of instance IDs to run, or path to a file containing instance IDs (one per line)"
    ),
    instance_file: Optional[str] = typer.Option(
        None, "--instance-file", help="Path to a file containing instance IDs (one per line). Alternative to --instance-filter"
    ),
    verify_mode: str = typer.Option(
        "prediction",
        "--verify-mode",
        help="Verification mode: prediction/none (skip verification; only generate predictions.jsonl), local (apply patch + run nodeid tests), or official (swebench.harness.run_evaluation).",
    ),
    cache_level: str = typer.Option(
        "env",
        "--cache-level",
        help="Official harness cache level: none/base/env/instance",
    ),
    clean: bool = typer.Option(
        True,
        "--clean/--no-clean",
        help="Official harness cleanup (flag): use --clean or --no-clean (do not pass True/False)",
    ),
) -> None:
    """Run batch evaluation on SWE-bench dataset.
    
    Batch mode directly reuses single instance logic (run-instance command).
    It loads instances and sequentially runs each one using the same execution path.
    
    Key differences from single mode:
    - Default verify_mode=local (skips official evaluation, only generates predictions.jsonl)
    - Serial execution (max_concurrency=1) by default to save storage
    - Automatically cleans up Docker images and containers after each instance to save storage
    - Supports resume functionality to skip completed instances
    
    All other features (timeout handling, error reporting, logging, etc.) are identical to single mode.
    """
    try:
        instance_ids = None
        
        # Load instance IDs from file or filter string
        if instance_file:
            file_path = Path(instance_file)
            if not file_path.exists():
                raise FileNotFoundError(f"Instance file not found: {instance_file}")
            instance_ids = [
                line.strip() 
                for line in file_path.read_text().splitlines() 
                if line.strip() and not line.strip().startswith("#")
            ]
            logger.info(
                "Loaded instance IDs from file",
                file_path=instance_file,
                count=len(instance_ids),
            )
        elif instance_filter:
            # Check if it's a file path
            filter_path = Path(instance_filter)
            if filter_path.exists():
                instance_ids = [
                    line.strip() 
                    for line in filter_path.read_text().splitlines() 
                    if line.strip() and not line.strip().startswith("#")
                ]
                logger.info(
                    "Loaded instance IDs from file (via --instance-filter)",
                    file_path=instance_filter,
                    count=len(instance_ids),
                )
            else:
                # Treat as comma-separated list
                instance_ids = [id.strip() for id in instance_filter.split(",")]
                logger.info(
                    "Loaded instance IDs from comma-separated list",
                    count=len(instance_ids),
                )
        
        logger.info(
            "Starting batch run",
            dataset=dataset,
            split=split,
            run_id=run_id,
            max_concurrency=max_concurrency,
            timeout=timeout,
            model_name=model_name,
            resume=resume,
            instance_count=len(instance_ids) if instance_ids else "all",
        )
        
        stats = asyncio.run(run_batch_orchestrator(
            dataset=dataset,
            split=split,
            run_id=run_id,
            max_concurrency=max_concurrency,
            timeout_per_instance=timeout,
            api_provider=api_provider,
            model_name_or_path=model_name or "costrict-swebench-v1",
            resume=resume,
            instance_ids=instance_ids,
            verify_mode=verify_mode,
            cache_level=cache_level,
            clean=clean,
        ))
        
        console.print("\n📊 Batch run completed!")
        console.print(f"✅ Successful: {stats['completed']}")
        console.print(f"❌ Failed: {stats['failed']}")
        console.print(f"⏰ Timeout: {stats['timeout']}")
        console.print(f"📁 Results saved to: .runs/{run_id}/")
        
    except Exception as e:
        logger.error(
            "Batch run failed",
            dataset=dataset,
            split=split,
            run_id=run_id,
            error=str(e),
            exc_info=True,
        )
        console.print(f"❌ Error: {e}")
        raise typer.Exit(1)


@app.command()
def export_preds(
    run_id: str = typer.Option(..., "--run-id", help="Run ID to export"),
    format: str = typer.Option(
        "jsonl", "--format", help="Export format: jsonl or json"
    ),
    output: Optional[str] = typer.Option(
        None, "--output", help="Output file path (default: stdout)"
    ),
    mode: Optional[str] = typer.Option(
        "dict", "--mode", help="JSON mode: dict or list (only for json format)"
    ),
) -> None:
    """Export predictions in specified format."""
    try:
        logger.info(
            "Exporting predictions",
            run_id=run_id,
            format=format,
            output=output,
            mode=mode,
        )
        
        export_predictions(
            run_id=run_id,
            format=format,
            output_path=output,
            json_mode=mode or "dict",
        )
        
        if output:
            console.print(f"✅ Predictions exported to: {output}")
        else:
            console.print("✅ Predictions exported to stdout")
            
    except Exception as e:
        logger.error(
            "Export failed",
            run_id=run_id,
            format=format,
            error=str(e),
            exc_info=True,
        )
        console.print(f"❌ Error: {e}")
        raise typer.Exit(1)


@app.command()
def report(
    run_id: str = typer.Option(..., "--run-id", help="Run ID to report"),
    output: Optional[str] = typer.Option(
        None, "--output", help="Output file path (default: stdout)"
    ),
) -> None:
    """Generate evaluation report for a run."""
    try:
        logger.info("Generating report", run_id=run_id, output=output)
        
        report_text = generate_report(run_id=run_id, output_path=output)
        
        if output:
            console.print(f"✅ Report generated: {output}")
        else:
            console.print(report_text)
            
    except Exception as e:
        logger.error(
            "Report generation failed",
            run_id=run_id,
            error=str(e),
            exc_info=True,
        )
        console.print(f"❌ Error: {e}")
        raise typer.Exit(1)


def main() -> None:
    """Main entry point."""
    # Check for required environment variables
    if not os.getenv("OPENROUTER_API_KEY"):
        console.print("⚠️  Warning: OPENROUTER_API_KEY not set in environment")
        console.print("   Set it in a .env file or export it before running")
    
    app()


if __name__ == "__main__":
    main()
