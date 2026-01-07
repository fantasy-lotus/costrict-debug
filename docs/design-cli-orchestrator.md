# CLI / 编排设计文档（costrict-swebench）

本文档说明 Python CLI（`costrict-swebench`）在 SWE-bench 评估中的编排设计：命令结构、参数语义、Docker 两容器 + 共享卷的数据流、关键产物、超时/续约、以及难点/亮点。

## 📦 关键架构：基于 VS Code 的 CoStrict 在无头 VS Code Docker 中运行，通过 IPC 通信

- **载体**：CoStrict 是一个 **VS Code 扩展**，不是独立 Python CLI。
- **运行环境**：在 `costrict-evals-runner:dev` 容器内，通过 `xvfb-run ... code ...` 启动 **headless VS Code**（无 GUI）。
- **通信方式**：CLI（`costrict-swebench`）通过 **IPC** 与扩展侧通信，传递 `instance-id`、`workspace-path`、`prompt-file`、`mode=swebench` 等参数。
- **优势**：复用 VS Code 的编辑器能力、工具系统与扩展机制，同时在 Docker 中实现无头运行与可重复评估。

## 目标

- 在本地或评估机上以 **SWE-bench 官方 Docker 镜像** 作为 testbed，运行 CoStrict agent 并产出官方 harness 兼容的 `predictions.jsonl`。
- 保证单实例可调试、批量可恢复（resume）、日志可追溯。

## CLI 入口与命令

入口：`costrict-debug-cli/costrict-debug-cli/src/costrict_swebench/cli.py`

### 1) run-instance

核心参数：

- `--instance-id`：SWE-bench instance id
- `--run-id`：本次运行 ID（输出目录 `.runs/{run_id}/`）
- `--timeout`：单实例 timeout（秒）
- `--api-provider`：LLM provider（如 `zgsm` / `openrouter` / `zai`）
- `--model-name`：写入预测文件的 `model_name_or_path`
- `--verify-mode`
    - `prediction`/`none`：只生成 prediction（最快，打榜常用）
    - `local`：本地快速验证（nodeid tests）
    - `official`：调用 `swebench.harness.run_evaluation` 进行官方验证
- `--cache-level` / `--no-clean`：官方 harness 相关

### 2) run-batch

批量运行的入口同样在 `cli.py`，并最终调用 `orchestration/runner.py` 的 `run_batch`：

- `--dataset` / `--split`：默认 `princeton-nlp/SWE-bench_Verified` / `test`
- `--max-concurrency`：并发数（默认 1，节省磁盘）
- `--instance-file` 或 `--instance-filter`：选择要跑的实例集（可从文件读取）
- `--resume`：跳过已完成实例（以实例目录中的 metadata/status 为依据）

## Orchestrator 核心职责

核心在：`costrict_swebench/orchestration/runner.py`。

### 1) 数据加载与镜像解析

- 通过 `SWEInstanceLoader` 读取 dataset/split，并解析每个实例的：
    - `repo` / `base_commit`
    - `problem_statement` / `hints_text`
    - `FAIL_TO_PASS` / `PASS_TO_PASS`
    - `env_startup_command`（若有）
- 通过 `resolve_image_name()` 决定使用哪一个官方 SWE-bench Docker 镜像。

### 2) Prompt 构造（CLI 侧）

`SWEOrchestrator._prepare_prompt()` 会生成一个“强约束 prompt block”，核心点：

- 明确告知：
    - FAIL_TO_PASS/PASS_TO_PASS 在环境中一定存在
    - 禁止修改/新增测试
    - 先探索再跑 FAIL_TO_PASS
    - 使用仓库自身的测试 runner（例如 django 的 `./tests/runtests.py`）
- **顺序思考**（MCP sequential-thinking）的调用规则也在此明确：
    - 默认开局一次
    - 两轮 patch→verify 失败后再调用
    - patch 前如果计划不清晰也应调用

该 prompt 会写入 runner 工作区（供 headless VS Code 读取）。

## Docker 编排：两容器 + 共享卷

实现位于：`costrict_swebench/infra/docker.py`。

### 1) 容器角色

- **Instance Container（testbed）**
    - 基于 SWE-bench 官方镜像
    - repo 位于 `/testbed`
    - 负责：checkout base_commit、必要时执行 env_startup_command、并把 repo 复制到共享卷

- **Runner Container（agent runner）**
    - 镜像：`costrict-evals-runner:dev`
    - 挂载共享卷到 `/workspace`，repo 工作目录为 `/workspace/repo`
    - 在容器内启动 headless VS Code + CoStrict 扩展 + swebench mode

- **共享卷（named volume）**
    - 将 `/testbed` 拷贝到 `/workspace/repo`，实现“官方环境一致性 + 可写工作区”。

### 2) 产物回收与目录结构

输出根目录：`.runs/{run_id}/`

- `predictions.jsonl`：官方 harness 兼容
- `instances/{instance_id}/`：
    - `progress.log`
    - `patch.diff`
    - `trajectory.json`（若有）
    - runner stdout tail / VS Code logs / messages log 等

## 超时与续约（runner 容器 watchdog）

在 `infra/docker.py` 的 runner 等待循环中实现：

- `initial_deadline = start_ts + timeout_seconds`
- `max_deadline = start_ts + timeout_seconds * 2`
- `renewal_grace_seconds = 180`（3 分钟）
- `early_stall_check_ts = start_ts + timeout_seconds * 0.5`

逻辑要点：

- 在 0.5×timeout 之后开始做“停滞检测”：
    - 如果 messages log 存在但在 180s 内没有更新，直接判定“runner stalled”并抛 `TimeoutError`。
- 到达 `deadline` 时：
    - 若尚未超过 `max_deadline` 且 messages log 在最近 180s 有更新：
        - `deadline += 180s`（最多到 `max_deadline`）
    - 否则：抛出超时（stall 或到达 2× cap）。

该机制的目的：

- 避免“仍在做有效工作”的实例被硬超时杀掉。
- 同时避免“卡死但仍占用容器”的实例无限续命。

## 难点 / 亮点

- **难点：真实 SWE-bench 环境差异与可写工作区**
    - 官方镜像 repo 在 `/testbed`，但 agent 需要可写空间与持久化产物。
    - 通过共享卷复制实现“环境一致 + 工作区可写”，并配合扩展侧 path mapping 抹平路径差异。

- **难点：长任务的稳定性与可恢复**
    - 真实实例可能卡住、空转、或 LLM 响应慢。
    - watchdog 的“续约 + stall 检测 + 2×上限”是工程化的折中。

- **亮点：打榜友好的 verify_mode=prediction**
    - 只生成 prediction，跳过本地/官方验证，吞吐更高。
    - 需要时可切换到 `official` 做抽检验证，兼顾效率与正确性。

- **亮点：prompt 与扩展侧 SWE-bench mode 的互补**
    - CLI prompt 强调任务级约束（测试存在、禁止改测试、顺序思考等）。
    - 扩展侧状态机/拦截器把这些约束落地到每一次工具调用，减少“模型遗忘规则”的风险。
