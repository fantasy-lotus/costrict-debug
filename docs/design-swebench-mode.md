# SWE-bench mode 设计文档（CoStrict 扩展侧）

本文档说明 CoStrict 在 SWE-bench 场景下的 `swebench` mode 设计：包括 prompt 体系、状态机、锦囊/行为约束、顺序思考（MCP）、路径映射、上下文压缩与可观测性。

## 📦 关键架构：基于 VS Code 的 CoStrict 在无头 VS Code Docker 中运行，通过 IPC 通信

- **载体**：CoStrict 是一个 **VS Code 扩展**，不是独立 Python CLI。
- **运行环境**：在 `costrict-evals-runner:dev` 容器内，通过 `xvfb-run ... code ...` 启动 **headless VS Code**（无 GUI）。
- **通信方式**：CLI（`costrict-swebench`）通过 **IPC** 与扩展侧通信，传递 `instance-id`、`workspace-path`、`prompt-file`、`mode=swebench` 等参数。
- **优势**：复用 VS Code 的编辑器能力、工具系统与扩展机制，同时在 Docker 中实现无头运行与可重复评估。

## 目标与约束

- **目标**
    - 提升 SWE-bench Verified 的 `% Resolved`：更少“盲改”、更快定位、更可验证的修复闭环。
    - 在 runner 容器内（headless VS Code）稳定运行，并与官方 harness 的输入输出格式兼容。

- **核心约束**
    - **先证据、后修改**：尽可能先得到 FAIL_TO_PASS 的失败信号，再进入修改。
    - **最小 patch**：降低回归风险，避免大重构。
    - **可恢复**：避免 agent 陷入重复循环、空转、过度上下文膨胀。

## 模块位置与关键文件

- `src/core/swebench/state-machine.ts`
    - 三阶段状态机与 tool gating
    - 计数器（read/test/modify）与动态 reasoning budget
- `src/core/swebench/tool-interceptor.ts`
    - 将状态机接入 CoStrict 工具系统的主入口（validate / record / path mapping / loop detection）
- `src/core/swebench/prompt-generator.ts`
    - 分阶段模板化 prompt（ANALYZE/MODIFY/VERIFY）
- `src/core/swebench/submit-review.ts`
    - “首次修改提示（锦囊）”与提交前 checklist
- `src/core/swebench/context-compression.ts`
    - SWE-bench 专属的对话压缩与工具结果保留策略

## 状态机（ANALYZE → MODIFY → VERIFY）

### 1) 阶段语义

- **ANALYZE**
    - 目标：定位问题、建立可验证的失败信号（优先 FAIL_TO_PASS）。
    - 允许工具：读文件/列目录/搜索/执行命令（测试/探索）、MCP。

- **MODIFY**
    - 目标：进行最小变更修复。
    - 允许工具：在 ANALYZE 基础上允许 `apply_diff`，以及 `write_to_file`（仅用于小型辅助脚本；不鼓励用来修改既有代码/测试）。

- **VERIFY**
    - 目标：复跑 FAIL_TO_PASS 与必要的 PASS_TO_PASS（或更小回归集合），确认修复有效，提交结果。
    - 允许工具：在 MODIFY 基础上允许 `attempt_completion`。

### 2) 关键 gating / 转移策略

- **测试驱动进入修改**
    - `state-machine.ts` 中记录 `execute_command` 后，会将 phase 从 `ANALYZE` 推进到 `MODIFY`。
    - 这是一种“强制先跑命令”的策略：对 SWE-bench 来说，“缺少失败信号就改”往往导致低成功率。

- **验证阶段进入**
    - 在 `MODIFY` 发生过代码修改后，会要求累计一定次数的 `execute_command`（用于验证/回归）以进入 `VERIFY`。
    - 该阈值由 `SWEBENCH_VERIFY_EXECUTE_COMMANDS_REQUIRED` 控制。

- **工具允许列表**
    - `PHASE_CONFIGS` 定义每个 phase 的 `allowedTools`。
    - `isToolAllowed()` / `getBlockReason()` 用于对不合规调用给出原因。

## Prompt 体系（模板化 + 分阶段指导）

### 1) 模板来源

`prompt-generator.ts` 定义 `DEFAULT_TEMPLATES`：分别对应 ANALYZE / MODIFY / VERIFY。

### 2) Prompt 的结构化要求

每个阶段都强调同一个可执行闭环：

- **RR（Recon/Reproduce）**：定位与复现
- **PLAN**：写出 3-6 步、每步是明确“工具动作/命令”
- **ACTION**：只执行下一步（避免一次做太多导致不可证伪）

### 3) 顺序思考（MCP sequential-thinking）

模板中明确要求：

- 使用 MCP server：`sequential-thinking`（带连字符）
- 用于：
    - 排序假设、选择下一条最小验证动作
    - 在多模块/多轮失败时升级 totalThoughts

这相当于把“链路化推理”外置为一个强约束：避免 agent 在 prompt 内长篇无证据推理，从而浪费上下文与时间。

## 工具拦截器（Tool Interceptor）

`tool-interceptor.ts` 的职责是把 SWE-bench 的约束“落地到每一次工具调用”。

### 1) Path mapping（/testbed → /workspace/repo）

- SWE-bench 官方镜像中 repo 通常位于 `/testbed`。
- runner 工作区是共享卷挂载的 `/workspace/repo`。

因此拦截器会对下列工具的路径参数做映射：

- `read_file` / `apply_diff` / `write_to_file` / `list_files` / `search_files` / `search_replace`

映射入口：`applyPathMappingToParams()`。

### 2) 循环检测与自救（防空转）

拦截器维护：

- `executionHistory`：最近 50 次工具执行
- `outputHistory`：最近 20 次输出摘要

并实现多个 loop detector：

- **输出循环**：重复输出几乎相同内容
- **重复失败**：相同操作连续失败
- **停滞检测**：长时间无工具调用（默认 5 分钟）

VERIFY 阶段的 loop 检测会更保守（允许多次测试），但也会在明显重复时提示尽快 `attempt_completion`。

### 3) “锦囊”（Guidance）

系统内有两类锦囊：

- **首次修改锦囊**：
    - 见 `submit-review.ts` 的 `SWEBENCH_FIRST_MODIFICATION_GUIDANCE`。
    - 目标：当 agent 在 ANALYZE 阶段第一次尝试 `apply_diff` 时，提醒先建立测试失败信号/完成探索。

- **第二锦囊/升级指导**：
    - `tool-interceptor.ts` 中有 `secondJinnangShown`、`consecutiveApplyDiffCount` 等，用于对连续补丁/无效循环做额外提示。

## 上下文压缩（SWE-bench 专属）

`context-compression.ts` 的设计目标：在长对话中保持“可继续性”，优先保留对成功率最关键的信息。

- **触发阈值**：默认在上下文使用率较高时触发（文件内 `SWEBENCH_CONDENSE_THRESHOLD`）。
- **保留策略**：保留最近若干次工具结果（默认 4 次），过长则截断。
- **摘要格式**：输出结构化 summary（包含 USER_CONTEXT、TESTS、CHANGES、NEXT_STEPS 等），方便下一轮 agent 接手。

此外，压缩后会调用 `resetAfterContextCompression()` 重置部分循环检测计数器，避免摘要后继续沿用旧计数导致误判。

## 可观测性（你在日志里能看到什么）

- 拦截器与状态机会通过 `console.log` 输出：
    - 当前 phase
    - phase transition
    - reasoning config 更新
    - 被阻止工具的原因
    - 重复/循环检测的提示

- runner/orchestrator 会把这些输出落盘到 `.runs/{run_id}/instances/{instance_id}/`（详见 CLI 编排文档）。

## 难点与亮点

- **难点：约束与效率的矛盾**
    - 约束过严会导致 agent 过度探索、浪费时间；过松会导致盲改。
    - 本实现采用“状态机 + 灵活探索策略 + 锦囊”组合，在不同阶段使用不同强度约束。

- **亮点：把成功率关键因素工程化**
    - 将“先跑测试、再改代码、再回归”固化为状态机和 prompt 模板。
    - 把 SWE-bench 的路径差异工程化为 `applyPathMapping`，减少无效读文件。
    - 引入循环检测与压缩策略，降低长任务超时/空转概率。
