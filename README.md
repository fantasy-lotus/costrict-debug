# CoStrict-Debug（基于 CoStrict 的 SWE-bench Debug Agent）

CoStrict-Debug 是一个面向 **SWE-bench Verified** 的 Debug Agent 方案：

- 以 **CoStrict（VS Code 扩展 + 自定义 mode）** 作为 agent 运行载体
- 以 **SWE-bench 官方 Docker 镜像** 作为“真实缺陷环境（testbed）”
- 以一个 **Python Orchestrator** 将 `instance(testbed)`、`workspace(repo)` 与 `headless VS Code runner` 串起来
- 产出 **harness 兼容的 `predictions.jsonl`**，可直接用于官方评估/提交

本仓库同时包含两部分：

- **CoStrict SWE-bench mode（TypeScript）**：在扩展侧实现工具约束、阶段控制、路径映射等，核心在 `src/core/swebench/`。
- **SWE-bench Orchestrator（Python）**：负责启动/编排 Docker 容器、收集日志与导出预测，代码在 `costrict-debug-cli/costrict-debug-cli/`（PyPI 名称：`costrict-swebench`）。

## SWE-bench mode（CoStrict 内）如何工作

CoStrict 的 `swebench` mode 通过“状态机 + 工具拦截器”约束 agent 行为，核心目标是提升 SWE-bench Verified 的 **% Resolved**：

- **阶段状态机**：`ANALYZE → MODIFY → VERIFY`（见 `src/core/swebench/state-machine.ts`）
    - `ANALYZE`：只允许读代码/列目录/搜索/跑命令（测试）
    - `MODIFY`：允许 `apply_diff`
    - `VERIFY`：允许再次测试并提交（attempt completion）
    - 关键约束：**未至少跑过一次测试前，`apply_diff` 会被阻止**（避免“盲改”）

- **工具拦截与路径映射**：`src/core/swebench/tool-interceptor.ts`
    - SWE-bench 镜像里 repo 通常在 `/testbed`（或 `/testbed/repo`）
    - 实际 agent 的工作目录是共享 volume 的 `/workspace/repo`
    - 因此对工具入参做映射：`/testbed/... → /workspace/repo/...`（避免 agent 因测试栈输出路径不一致而读错文件）

## VSCode Docker 与 instance 的编排（本仓库如何跑起来）

该项目在 Docker 中使用“两容器 + 共享 volume”的架构（详情见 `SWEBENCH-TESTBED-WORKSPACE-关系.md`）：

- **Instance Container（SWE-bench 镜像）**
    - repo 预置在 `/testbed`（官方约定）
    - 负责：checkout 到 `base_commit`、必要时执行 `env_startup_command`、并通过 `tar` 复制 repo 到共享 volume

- **Runner Container（`costrict-evals-runner:dev`）**
    - 挂载同一个 Docker named volume 到 `/workspace`
    - 工作目录为 `/workspace/repo`
    - 在容器内通过 `xvfb-run ... code ...` 启动 **headless VS Code**，并通过 IPC 与 CoStrict 扩展通信
    - runner 入口实际调用：`pnpm --filter @roo-code/evals cli --instance-id ... --workspace-path ... --prompt-file ... --mode swebench ...`

- **共享 Volume（关键）**
    - instance 将 `/testbed` 复制到 `/workspace/repo`
    - runner 在 `/workspace/repo` 执行读写与测试
    - 扩展层的 swebench path mapping 负责把测试输出中的 `/testbed/...` 转为 `/workspace/repo/...`

## 输出产物（用于评估/打榜）

默认运行会在当前工作目录生成 `.runs/{run_id}/`：

- `predictions.jsonl`：**官方 harness 兼容**（每行含 `instance_id / model_name_or_path / model_patch`）
- `all_preds.jsonl`：简化 JSONL（用于内部或其他工具链）
- `preds.json`：dict 形式的 `{instance_id: patch}`
- `instances/{instance_id}/...`：单个实例的日志与中间产物（`progress.log`、`patch.diff`、runner stdout tail、VS Code logs 等）

## Quick Start

从零开始跑通一次单实例/批量、并导出 `predictions.jsonl`：

- 见：[`docs/quick-start.md`](docs/quick-start.md)

## Design Docs

- SWE-bench mode（prompt/状态机/锦囊/顺序思考/路径映射/压缩/可观测性）：[`docs/design-swebench-mode.md`](docs/design-swebench-mode.md)
- CLI/编排（costrict-swebench 子命令/参数语义/Docker 编排/超时续约/难点亮点）：[`docs/design-cli-orchestrator.md`](docs/design-cli-orchestrator.md)

## 目录导航

- `src/core/swebench/`：CoStrict 内的 SWE-bench mode（状态机/拦截器/提示词生成/上下文压缩等）
- `packages/evals/`：runner 的 TS CLI（会在容器内启动 headless VS Code）
- `packages/evals/Dockerfile.runner`：构建 `costrict-evals-runner:dev` 的 Dockerfile
- `costrict-debug-cli/costrict-debug-cli/`：Python orchestrator（CLI：`costrict-swebench`）
