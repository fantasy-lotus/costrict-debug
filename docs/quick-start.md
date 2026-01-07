# Quick Start（SWE-bench Verified）

> **重要**：运行前必须确保 Docker Desktop（或 Docker Engine）已启动。  
> 若遇到 `Cannot connect to Docker daemon`，在 macOS 常见解决方式：
>
> ```bash
> export DOCKER_HOST=unix:///Users/lotus/.docker/run/docker.sock
> ```

目标：在本仓库中跑通一次 CoStrict-Debug（CoStrict + SWE-bench mode + Docker 编排），并导出可用于官方评估/提交的 `predictions.jsonl`。

## 前置条件

- Docker Desktop / Docker Engine
- Python >= 3.11
- Node.js（建议 20.x；本仓库 `package.json` 约束为 20.19.2）

## 1) 构建 runner 镜像（必须）

Python orchestrator 默认使用 `costrict-evals-runner:dev` 作为 runner 镜像（见 `costrict-debug-cli/costrict-debug-cli/src/costrict_swebench/infra/docker.py`）。

在仓库根目录执行：

```bash
docker build -f packages/evals/Dockerfile.runner -t costrict-evals-runner:dev .
```

在构建 runner 镜像前，请先新建 `packages/evals/.env.local` 并写入 `OPENROUTER_API_KEY=`（即使不使用 OPENROUTER，也需要这个占位以避免 Dockerfile.runner 的 `COPY packages/evals/.env.local` 失败）。

## 2) 安装 Python orchestrator（必须）

在仓库根目录执行：

```bash
pip install -e costrict-debug-cli
```

验证：

```bash
costrict-swebench --help
```

## 3) 配置认证/密钥

根据你使用的 provider 设置环境变量（runner 容器会透传）：

```bash
export OPENROUTER_API_KEY="..."   # 使用 openrouter 时
export ZAI_API_KEY="..."          # 使用 zai 时
export ROO_CODE_CLOUD_TOKEN="..."  # 可选
```

如果你使用 `--api-provider zgsm`：

- runner 会尝试读取 `~/.costrict/share/auth.json`（并在容器中挂载到 `/roo/.costrict/share`）
- 若未找到或 token 过期，会在 runner 容器内报错（类似“CoStrict auth not found”）

**常见问题**：

- `zgsm` 需要先在 VS Code 中登录 CoStrict（zgsm）一次，生成 `~/.costrict/share/auth.json`
- `openrouter` 需要有效的 API key，否则会在调用 LLM 时失败
- `zai` 需要设置 `ZAI_API_KEY`，并确保网络可访问对应服务

## 4) 跑通一个单实例（推荐）

在仓库根目录执行：

```bash
costrict-swebench run-instance \
  --instance-id django__django-11055 \
  --run-id quick-001 \
  --timeout 600 \
  --api-provider zgsm \
  --verify-mode prediction
```

产物目录：

- `.runs/quick-001/instances/django__django-11055/`

## 5) 批量运行（生成 predictions）

### 5.1 跑整个 Verified test split（500）

```bash
costrict-swebench run-batch \
  --dataset princeton-nlp/SWE-bench_Verified \
  --split test \
  --run-id verified-500 \
  --max-concurrency 1 \
  --timeout 600 \
  --api-provider zgsm \
  --verify-mode prediction
```

### 5.2 跑指定 instance 列表

```bash
cat > instances.txt << 'EOF'
django__django-11055
pytest-dev__pytest-10356
EOF

costrict-swebench run-batch \
  --run-id subset-001 \
  --instance-file instances.txt \
  --timeout 600 \
  --api-provider zgsm \
  --verify-mode prediction
```

## 6) 导出 predictions.jsonl（用于官方评估/提交）

```bash
costrict-swebench export-preds \
  --run-id verified-500 \
  --format jsonl \
  --output predictions.jsonl
```

## 7) （可选）官方 harness 本地验证

如果你的本机 python 环境已安装 `swebench`，并希望对单个实例跑官方验证：

```bash
costrict-swebench run-instance \
  --instance-id django__django-11055 \
  --run-id quick-001 \
  --timeout 1200 \
  --api-provider zgsm \
  --verify-mode official \
  --cache-level env \
  --no-clean
```

## 9) 超时续约机制（重要）

当你使用 `--timeout 1500`（1500 秒）时，runner 容器的超时并非硬性终止，而是**有续约机制**：

- **初始 deadline**：`timeout_seconds`（如 1500s）
- **最大 deadline**：`timeout_seconds * 2`（如 3000s）
- **续约窗口**：从 `timeout_seconds * 0.5` 开始检查（如 750s）
- **续约条件**：如果最近 3 分钟内（`renewal_grace_seconds = 180s`）有 agent 消息日志更新，则自动延长 deadline 3 分钟
- **终止条件**：如果既未收到结构化结果，且消息日志已超过 3 分钟未更新，则抛出超时

因此，即使你设 `--timeout 1500`，只要 agent 仍在活跃（日志在更新），实际运行时间可最长到 3000s（2×）。

### 常用命令（示例）

```bash
costrict-swebench run-batch \
  --run-id costrict-debug-agent \
  --instance-file instances.txt \
  --timeout 1500
```

说明：

- `--timeout 1500`：单实例初始超时 1500s，最长可续约到 3000s
- `--verify-mode prediction`：默认值，只生成 predictions（不跑官方 harness）

## 8) 常用调试开关

- `COSTRICT_KEEP_RUNNER_CONTAINER=1`：不自动删除 runner container（便于排查 runner 内环境/日志）

## 10) 提交到 SWE-bench（sb-cli）

官方文档：

- https://www.swebench.com/sb-cli/

### 10.1 准备 predictions 文件（给 sb-cli 用）

sb-cli 常见使用的是 JSON 文件（而本项目默认产出 `predictions.jsonl`/`all_preds.jsonl`）。建议你从 run 目录里导出一个 **JSON list** 版本

### 10.2 常用 sb-cli 提交命令

下面是你常用的提交命令模板（按需替换路径与 run_id）：

```bash
sb-cli submit swe-bench_verified test \
  --predictions_path costrict-debug-cli/.runs/costrict-debug-agent/predictions.json \
  --run_id test114514 \
  --output_dir costrict-debug-cli/sb-cli-reports \
  --overwrite 1 \
  --gen_report 1 \
  --wait_for_evaluation 1
```

参数含义（简要）：

- `--predictions_path`：待提交的 predictions 文件路径（建议使用上一步导出的 `predictions.json`）
- `--run_id`：你在 sb-cli/官网侧看到的运行 ID（用于区分多次提交）
- `--output_dir`：sb-cli 在本地落盘报告的目录
- `--gen_report 1`：生成报告
- `--wait_for_evaluation 1`：等待评测完成后再退出
