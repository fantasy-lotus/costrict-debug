/**
 * SWE-bench Context Compression
 *
 * SWE-bench 专属的上下文压缩功能，与 CoStrict 主系统隔离。
 *
 * 特点：
 * 1. 50% 上下文使用率触发压缩
 * 2. 保留最近 4 次工具调用结果（过长则截断）
 * 3. 使用 SWE-bench 专用摘要提示词，保留测试相关信息
 * 4. 不影响 CoStrict 主系统的压缩逻辑
 */

import Anthropic from "@anthropic-ai/sdk"
import crypto from "crypto"

import { ApiHandler } from "../../api"
import { ApiMessage } from "../task-persistence/apiMessages"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"

// SWE-bench 专用配置
export const SWEBENCH_CONDENSE_THRESHOLD = 70 // 70% 触发压缩
export const SWEBENCH_TOOL_RESULTS_TO_KEEP = 4 // 保留最近 4 次工具调用结果
export const SWEBENCH_MAX_TOOL_RESULT_LENGTH = 8000 // 单个工具结果最大长度（字符）
export const SWEBENCH_TOKEN_BUFFER_PERCENTAGE = 0.1 // 10% 缓冲区
export const SWEBENCH_MIN_SUMMARY_TOKENS = 2000 // 摘要最小 token 数
export const SWEBENCH_MAX_SUMMARY_ENHANCEMENT_ATTEMPTS = 3 // 最大补充尝试次数

// Avoid back-to-back condense loops: require some new messages after the last summary.
export const SWEBENCH_MIN_MESSAGES_BETWEEN_SUMMARIES = 20

// Target utilization AFTER condense (to avoid immediately triggering another condense).
// This is applied only when contextWindow is provided.
export const SWEBENCH_POST_CONDENSE_TARGET_UTILIZATION = 0.4

const SWEBENCH_AGGRESSIVE_TOOL_RESULTS_TO_KEEP = 2
const SWEBENCH_AGGRESSIVE_MAX_TOOL_RESULT_LENGTH = 4000
const SWEBENCH_TOOL_USE_TRUNCATION_LENGTH = 2000

/**
 * SWE-bench 专用摘要提示词
 * 重点保留测试信息、文件修改、问题解决进度
 */
function getSWEBenchSummaryPrompt(statistics?: {
	phase: string
	testsRunCount: number
	modificationCount: number
	readCallsCount: number
	testCallsCount: number
	attemptCompletionCount: number
	modifiedFiles: string[]
	messagesCompressed: number
}): string {
	const statsSection = statistics
		? `
**IMPORTANT CONTEXT - Work Progress Statistics:**
- Current Phase: ${statistics.phase}
- Total Tool Calls: ${statistics.readCallsCount} read_file, ${statistics.testCallsCount} test executions
- Modifications Made: ${statistics.modificationCount} code changes across ${statistics.modifiedFiles.length} file(s): ${statistics.modifiedFiles.slice(0, 5).join(", ")}${statistics.modifiedFiles.length > 5 ? "..." : ""}
- Tests Run: ${statistics.testsRunCount} test executions
- Completion Attempts: ${statistics.attemptCompletionCount}
- Messages Compressed: ${statistics.messagesCompressed} previous messages summarized

**Progress Analysis Required:**
Based on these statistics, analyze:
- What has been accomplished so far (consider the effort invested)
- Current progress status (e.g., "Made ${statistics.modificationCount} modifications but tests still failing")
- Potential issues or blockers identified (e.g., "May be approaching the problem incorrectly")
- Recommended next steps or alternative approaches to consider

`
		: ""

	return `\
You are summarizing a SWE-bench task conversation into a STRUCTURED STATE SUMMARY so another agent can continue without rereading the full history.
	
${statsSection}Output MUST follow this exact sectioned format (use the headers verbatim):
	
USER_CONTEXT:
- Goal / success criteria in 1-3 bullets.
	
CONSTRAINTS:
- SWE-bench constraints (e.g., do not modify repo tests; no network; minimal patch; respect PASS_TO_PASS).
- Any harness/runner constraints discovered.
	
TASK_TRACKING:
- Completed:
  - Bullet list of completed milestones.
- Pending:
  - Bullet list of remaining milestones.
- Current Phase: ANALYZE / MODIFY / VERIFY.
- Current hypothesis (ranked) and confidence (low/med/high).
	
CODE_STATE:
- Repository structure insights relevant to the failure.
- Key files inspected (path -> why it matters).
- Key functions/classes (name -> what role).
- Dependencies/config that affect behavior.
	
TESTS:
- FAIL_TO_PASS (preserve names exactly):
  - <name> :: status (failing/passing/unknown)
- PASS_TO_PASS (preserve names exactly):
  - <name> :: status (failing/passing/unknown)
- Commands executed (preserve exactly):
  - <command> -> <high-signal output excerpt>
- Test discovery notes (collect-only/-k findings, runner used, plugins affecting collection).
	
CHANGES:
- Files modified (path -> what changed and why).
- Attempts that failed (what was tried -> why it failed / what was learned).
${statistics ? `- Progress note: ${statistics.modificationCount} modification(s) made; ${statistics.readCallsCount} file reads; ${statistics.testCallsCount} test runs.` : ""}
	
ERRORS:
- Key error messages / stack traces (short excerpts) and where they came from.
	
NEXT_STEPS:
- 1-3 concrete next actions (each must be a tool action: read_file / search_files / execute_command / apply_diff).
- For each action: expected signal and how it will update the hypothesis.
	
Rules:
- Be thorough but concise.
- Preserve test names and commands EXACTLY.
- Do NOT include raw diffs; summarize intent and impacted code instead.
${statistics ? `\nRemember: ${statistics.messagesCompressed} previous messages were compressed; include a short progress assessment and whether an alternative approach is warranted.` : ""}
Output ONLY the structured summary.
`
}

/**
 * 检查消息是否包含工具结果
 */
function hasToolResultBlocks(message: ApiMessage): boolean {
	if (message.role !== "user" || typeof message.content === "string") {
		return false
	}
	return message.content.some((block) => block.type === "tool_result")
}

/**
 * 获取消息中的工具使用块
 */
function getToolUseBlocks(message: ApiMessage): Anthropic.Messages.ToolUseBlock[] {
	if (message.role !== "assistant" || typeof message.content === "string") {
		return []
	}
	return message.content.filter((block) => block.type === "tool_use") as Anthropic.Messages.ToolUseBlock[]
}

/**
 * 截断过长的工具结果内容
 */
function truncateToolResultContent(content: string, maxLength: number): string {
	if (content.length <= maxLength) {
		return content
	}

	// 计算截断提示的预估长度
	// 提示格式: "\n\n... [TRUNCATED: ${removedChars} characters removed] ...\n\n"
	// 基础长度约 50 字符，加上 removedChars 的位数
	const removedChars = content.length - (maxLength - 100) // 预估移除的字符数
	const removedCharsStr = removedChars.toString()
	const truncationHintLength = 50 + removedCharsStr.length // 预估提示长度

	// 确保有足够空间：预留提示空间，然后对剩余空间对半分
	const reservedForHint = Math.max(truncationHintLength, 100) // 至少预留 100 字符
	const truncatedLength = maxLength - reservedForHint
	const halfLength = Math.floor(truncatedLength / 2)

	// 构建截断内容
	const prefix = content.substring(0, halfLength)
	const suffix = content.substring(content.length - halfLength)
	const actualRemoved = content.length - (prefix.length + suffix.length)
	const truncationHint = `\n\n... [TRUNCATED: ${actualRemoved} characters removed] ...\n\n`

	const result = prefix + truncationHint + suffix

	// 如果仍然超过限制（可能因为提示长度估算不准确），进一步截断
	if (result.length > maxLength) {
		const excess = result.length - maxLength
		// 从两端各截断 excess/2
		const trimFromPrefix = Math.floor(excess / 2)
		const trimFromSuffix = Math.ceil(excess / 2)
		return (
			prefix.substring(0, Math.max(0, halfLength - trimFromPrefix)) +
			truncationHint +
			suffix.substring(Math.max(0, halfLength - trimFromSuffix))
		)
	}

	return result
}

/**
 * 处理工具结果块，截断过长内容
 */
function processToolResultBlock(
	block: Anthropic.Messages.ToolResultBlockParam,
	maxLength: number,
): Anthropic.Messages.ToolResultBlockParam {
	if (typeof block.content === "string") {
		return {
			...block,
			content: truncateToolResultContent(block.content, maxLength),
		}
	}
	// 对于数组内容：按“总长度”截断，而不是逐块截断（避免多个大块叠加导致压缩后仍很大）
	if (Array.isArray(block.content)) {
		let combined = ""
		for (const item of block.content) {
			if (item.type === "text") {
				combined += item.text
			} else {
				combined += `\n[Non-text tool result omitted: ${item.type}]\n`
			}
		}
		return {
			...block,
			content: truncateToolResultContent(combined, maxLength),
		}
	}
	return block
}

function truncateLargeStringField(value: unknown, maxLength: number): unknown {
	if (typeof value !== "string") {
		return value
	}
	return truncateToolResultContent(value, maxLength)
}

function truncateToolUseBlock(
	block: Anthropic.Messages.ToolUseBlock,
	maxFieldLength: number,
): Anthropic.Messages.ToolUseBlock {
	// We must not change id/name/type, only reduce input payload sizes.
	const input = (block as any).input as Record<string, unknown> | undefined
	if (!input) {
		return block
	}

	const toolName = String((block as any).name ?? "")
	const nextInput: Record<string, unknown> = { ...input }

	// Common large fields across edit tools
	if ("diff" in nextInput) {
		nextInput.diff = truncateLargeStringField(nextInput.diff, maxFieldLength)
	}
	if ("content" in nextInput) {
		nextInput.content = truncateLargeStringField(nextInput.content, maxFieldLength)
	}
	if ("file_text" in nextInput) {
		nextInput.file_text = truncateLargeStringField(nextInput.file_text, maxFieldLength)
	}
	if ("patch" in nextInput) {
		nextInput.patch = truncateLargeStringField(nextInput.patch, maxFieldLength)
	}

	// apply_diff tends to be the largest; be stricter if needed.
	if (toolName === "apply_diff") {
		nextInput.diff = truncateLargeStringField(nextInput.diff, maxFieldLength)
	}

	return { ...(block as any), input: nextInput }
}

function prepareKeptAssistantMessages(messages: ApiMessage[], maxToolUseFieldLength: number): ApiMessage[] {
	return messages.map((message) => {
		if (message.role !== "assistant" || typeof message.content === "string") {
			return message
		}
		const processedContent = message.content.map((block) => {
			if (block.type === "tool_use") {
				return truncateToolUseBlock(block as Anthropic.Messages.ToolUseBlock, maxToolUseFieldLength)
			}
			return block
		})
		return { ...message, content: processedContent }
	})
}

async function computeContextTokens(
	apiHandler: ApiHandler,
	systemPrompt: string,
	messages: ApiMessage[],
): Promise<number> {
	const systemPromptMessage: ApiMessage = { role: "user", content: systemPrompt }

	const existingSummaryIds = new Set<string>()
	for (const msg of messages) {
		if (msg.isSummary && msg.condenseId) {
			existingSummaryIds.add(msg.condenseId)
		}
	}
	const effectiveMessages = messages.filter((msg) => {
		if (msg.condenseParent && existingSummaryIds.has(msg.condenseParent)) {
			return false
		}
		return true
	})

	const allContextMessages = [systemPromptMessage, ...effectiveMessages]
	const contextBlocks = allContextMessages.flatMap((message) =>
		typeof message.content === "string" ? [{ text: message.content, type: "text" as const }] : message.content,
	)

	return apiHandler.countTokens(contextBlocks)
}

/**
 * 获取最近 N 次工具调用的消息对（assistant tool_use + user tool_result）
 * 返回需要保留的消息索引集合
 */
function getRecentToolCallIndices(messages: ApiMessage[], toolResultsToKeep: number): Set<number> {
	const indicesToKeep = new Set<number>()
	let toolResultCount = 0

	// 从后向前遍历，找到最近的工具调用对
	for (let i = messages.length - 1; i >= 0 && toolResultCount < toolResultsToKeep; i--) {
		const message = messages[i]

		// 找到包含 tool_result 的用户消息
		if (hasToolResultBlocks(message)) {
			// 提取 tool_result 的 tool_use_id 集合
			const toolResultIds = new Set<string>()
			if (Array.isArray(message.content)) {
				message.content.forEach((block) => {
					if (block.type === "tool_result") {
						toolResultIds.add((block as Anthropic.Messages.ToolResultBlockParam).tool_use_id)
					}
				})
			}

			// 找到对应的 assistant 消息（包含匹配的 tool_use）
			let foundMatchingToolUse = false
			if (i > 0) {
				const prevMessage = messages[i - 1]
				if (prevMessage.role === "assistant") {
					const toolUseBlocks = getToolUseBlocks(prevMessage)
					// 验证是否有匹配的 tool_use
					for (const toolUse of toolUseBlocks) {
						if (toolResultIds.has(toolUse.id)) {
							foundMatchingToolUse = true
							break
						}
					}
					if (foundMatchingToolUse) {
						indicesToKeep.add(i - 1)
					}
				}
			}

			// 只有当找到匹配的 tool_use 时，才保留这个 tool_result
			if (foundMatchingToolUse || toolResultIds.size === 0) {
				indicesToKeep.add(i)
				toolResultCount++
			}
		}
	}

	return indicesToKeep
}

/**
 * 准备保留的消息，截断过长的工具结果
 */
function prepareKeptMessages(messages: ApiMessage[], maxToolResultLength: number): ApiMessage[] {
	return messages.map((message) => {
		if (message.role !== "user" || typeof message.content === "string") {
			return message
		}

		// 处理包含 tool_result 的消息
		const processedContent = message.content.map((block) => {
			if (block.type === "tool_result") {
				return processToolResultBlock(block as Anthropic.Messages.ToolResultBlockParam, maxToolResultLength)
			}
			return block
		})

		return { ...message, content: processedContent }
	})
}

export type SWEBenchSummarizeResponse = {
	messages: ApiMessage[]
	summary: string
	cost: number
	newContextTokens?: number
	error?: string
	condenseId?: string
}

/**
 * SWE-bench 专用上下文压缩
 *
 * @param messages - 对话消息
 * @param apiHandler - API 处理器
 * @param systemPrompt - 系统提示词
 * @param taskId - 任务 ID
 * @param prevContextTokens - 当前上下文 token 数
 * @param useNativeTools - 是否使用原生工具协议
 * @returns 压缩结果
 */
export type SWEBenchSummarizeOptions = {
	messages: ApiMessage[]
	apiHandler: ApiHandler
	systemPrompt: string
	taskId: string
	prevContextTokens: number
	useNativeTools?: boolean
	contextWindow?: number
	maxTokens?: number | null
	stateMachine?: {
		getState: () => {
			phase: string
			testsRunCount: number
			modificationCount: number
			readCallsCount: number
			testCallsCount: number
			attemptCompletionCount: number
			modifiedFiles: string[]
		}
	}
}

export async function summarizeSWEBenchConversation(
	messages: ApiMessage[],
	apiHandler: ApiHandler,
	systemPrompt: string,
	taskId: string,
	prevContextTokens: number,
	useNativeTools?: boolean,
	contextWindow?: number,
	maxTokens?: number | null,
	stateMachine?: {
		getState: () => {
			phase: string
			testsRunCount: number
			modificationCount: number
			readCallsCount: number
			testCallsCount: number
			attemptCompletionCount: number
			modifiedFiles: string[]
		}
	},
): Promise<SWEBenchSummarizeResponse> {
	const response: SWEBenchSummarizeResponse = { messages, cost: 0, summary: "" }

	// 获取最近工具调用的索引
	const recentToolIndices = getRecentToolCallIndices(messages, SWEBENCH_TOOL_RESULTS_TO_KEEP)

	// 计算需要保留的消息
	// 1. 第一条消息（任务描述）
	// 2. 最近的工具调用对
	// 3. 最后一条消息（如果不在工具调用中）
	const keepIndices = new Set<number>([0]) // 始终保留第一条

	// 添加最近工具调用的索引
	recentToolIndices.forEach((idx) => keepIndices.add(idx))

	// 确保最后一条消息被保留
	if (messages.length > 0) {
		keepIndices.add(messages.length - 1)
	}

	// 分离要摘要的消息和要保留的消息
	const messagesToSummarize: ApiMessage[] = []
	const keepMessages: ApiMessage[] = []

	messages.forEach((msg, idx) => {
		if (keepIndices.has(idx)) {
			keepMessages.push(msg)
		} else {
			messagesToSummarize.push(msg)
		}
	})

	// 如果没有足够的消息需要摘要，跳过
	if (messagesToSummarize.length <= 2) {
		return { ...response, error: "Not enough messages to summarize" }
	}

	// 检查是否最近已经有摘要
	let lastSummaryIndex = -1
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.isSummary) {
			lastSummaryIndex = i
			break
		}
	}
	if (lastSummaryIndex >= 0) {
		const messagesAfterLastSummary = messages.length - 1 - lastSummaryIndex
		if (messagesAfterLastSummary < SWEBENCH_MIN_MESSAGES_BETWEEN_SUMMARIES) {
			return { ...response, error: "Recently summarized, skipping" }
		}
	}

	// 收集统计信息（如果可用）
	let statistics:
		| {
				phase: string
				testsRunCount: number
				modificationCount: number
				readCallsCount: number
				testCallsCount: number
				attemptCompletionCount: number
				modifiedFiles: string[]
				messagesCompressed: number
		  }
		| undefined

	if (stateMachine) {
		try {
			const state = stateMachine.getState()
			statistics = {
				phase: state.phase,
				testsRunCount: state.testsRunCount,
				modificationCount: state.modificationCount,
				readCallsCount: state.readCallsCount,
				testCallsCount: state.testCallsCount,
				attemptCompletionCount: state.attemptCompletionCount,
				modifiedFiles: state.modifiedFiles,
				messagesCompressed: messagesToSummarize.length,
			}
		} catch (error) {
			console.warn("[SWEBench-Condense] Failed to get state machine statistics:", error)
		}
	}

	// 准备摘要请求
	const finalRequestMessage: Anthropic.MessageParam = {
		role: "user",
		content: "Summarize the SWE-bench task conversation so far, following the format specified in the prompt.",
	}

	const requestMessages = maybeRemoveImageBlocks([...messagesToSummarize, finalRequestMessage], apiHandler).map(
		({ role, content }) => ({ role, content }),
	)

	// 生成包含统计信息的摘要提示词
	const summaryPrompt = getSWEBenchSummaryPrompt(statistics)

	// 调用 LLM 生成摘要
	let summary = ""
	let cost = 0
	let outputTokens = 0
	let enhancementAttempts = 0

	// 生成初始摘要
	const stream = apiHandler.createMessage(summaryPrompt, requestMessages)

	for await (const chunk of stream) {
		if (chunk.type === "text") {
			summary += chunk.text
		} else if (chunk.type === "usage") {
			cost = chunk.totalCost ?? 0
			outputTokens = chunk.outputTokens ?? 0
		}
	}

	summary = summary.trim()

	if (summary.length === 0) {
		return { ...response, cost, error: "Failed to generate summary" }
	}

	// 检查摘要长度，如果不够则补充
	let summaryTokens = outputTokens || (await apiHandler.countTokens([{ type: "text", text: summary }]))

	while (
		summaryTokens < SWEBENCH_MIN_SUMMARY_TOKENS &&
		enhancementAttempts < SWEBENCH_MAX_SUMMARY_ENHANCEMENT_ATTEMPTS
	) {
		enhancementAttempts++
		console.log(
			`[SWEBench-Condense] Summary too short (${summaryTokens} tokens, minimum ${SWEBENCH_MIN_SUMMARY_TOKENS}), enhancing (attempt ${enhancementAttempts}/${SWEBENCH_MAX_SUMMARY_ENHANCEMENT_ATTEMPTS})`,
		)

		// 构建补充请求
		const enhancementPrompt = `\
The previous summary was too brief (${summaryTokens} tokens). Please expand it to be more comprehensive and detailed.

Current summary:
${summary}

Please enhance the summary by:
1. Adding more details about the problem understanding and root cause analysis
2. Expanding on test information and findings
3. Providing more context about code exploration and key discoveries
4. Including more details about modifications made and approaches tried
5. Expanding on current status, progress analysis, and potential issues
6. Adding more technical context and insights

The enhanced summary should be at least ${SWEBENCH_MIN_SUMMARY_TOKENS} tokens and include all the required sections. Be thorough and detailed while maintaining clarity.`

		const enhancementRequestMessage: Anthropic.MessageParam = {
			role: "user",
			content: enhancementPrompt,
		}

		// 调用 LLM 补充摘要
		const enhancementStream = apiHandler.createMessage("", [enhancementRequestMessage])
		let enhancedSummary = ""

		for await (const chunk of enhancementStream) {
			if (chunk.type === "text") {
				enhancedSummary += chunk.text
			} else if (chunk.type === "usage") {
				cost += chunk.totalCost ?? 0
				outputTokens = chunk.outputTokens ?? 0
			}
		}

		enhancedSummary = enhancedSummary.trim()

		if (enhancedSummary.length > 0) {
			summary = enhancedSummary
			summaryTokens = outputTokens || (await apiHandler.countTokens([{ type: "text", text: summary }]))
			console.log(`[SWEBench-Condense] Enhanced summary now has ${summaryTokens} tokens`)
		} else {
			console.warn(`[SWEBench-Condense] Enhancement attempt ${enhancementAttempts} failed to generate content`)
			break
		}
	}

	if (summaryTokens < SWEBENCH_MIN_SUMMARY_TOKENS) {
		console.warn(
			`[SWEBench-Condense] Summary still below minimum (${summaryTokens} tokens, minimum ${SWEBENCH_MIN_SUMMARY_TOKENS}) after ${enhancementAttempts} enhancement attempts`,
		)
		// 继续使用现有摘要，不返回错误（因为至少有一些内容）
	}

	// 生成唯一的 condenseId
	const condenseId = crypto.randomUUID()

	function buildCondensedMessages(
		toolResultsToKeep: number,
		maxToolResultLength: number,
	): {
		messages: ApiMessage[]
		insertedSummaryId: string
	} {
		const recentToolIndicesLocal = getRecentToolCallIndices(messages, toolResultsToKeep)
		const keepIndicesLocal = new Set<number>([0])
		recentToolIndicesLocal.forEach((idx) => keepIndicesLocal.add(idx))
		if (messages.length > 0) {
			keepIndicesLocal.add(messages.length - 1)
		}

		const keepMessagesLocal: ApiMessage[] = []
		messages.forEach((msg, idx) => {
			if (keepIndicesLocal.has(idx)) {
				keepMessagesLocal.push(msg)
			}
		})

		// Truncate large tool_use inputs and tool_results in kept messages.
		const processedAssistant = prepareKeptAssistantMessages(keepMessagesLocal, SWEBENCH_TOOL_USE_TRUNCATION_LENGTH)
		const processedKeepMessagesLocal = prepareKeptMessages(processedAssistant, maxToolResultLength)

		// Create summary message
		const firstKeptTsLocal = processedKeepMessagesLocal[0]?.ts ?? Date.now()
		const summaryMessageLocal: ApiMessage = {
			role: "assistant",
			content: summary,
			ts: firstKeptTsLocal - 1,
			isSummary: true,
			condenseId,
		}

		// Map processed keep messages back to indices
		const processedKeepMapLocal = new Map<number, ApiMessage>()
		let keepIdxLocal = 0
		messages.forEach((_, idx) => {
			if (keepIndicesLocal.has(idx)) {
				processedKeepMapLocal.set(idx, processedKeepMessagesLocal[keepIdxLocal])
				keepIdxLocal++
			}
		})

		const newMessagesLocal = messages.map((msg, index) => {
			if (index === 0) {
				return msg
			}
			if (keepIndicesLocal.has(index)) {
				return processedKeepMapLocal.get(index) || msg
			}
			if (!msg.condenseParent) {
				return { ...msg, condenseParent: condenseId }
			}
			return msg
		})

		let insertPositionLocal = 1
		for (let i = 1; i < messages.length; i++) {
			if (!keepIndicesLocal.has(i)) {
				insertPositionLocal = i
				break
			}
		}
		if (insertPositionLocal === 1 && keepIndicesLocal.has(1)) {
			insertPositionLocal = messages.length
		}
		newMessagesLocal.splice(insertPositionLocal, 0, summaryMessageLocal)

		return { messages: newMessagesLocal, insertedSummaryId: condenseId }
	}

	let newMessagesResult = buildCondensedMessages(SWEBENCH_TOOL_RESULTS_TO_KEEP, SWEBENCH_MAX_TOOL_RESULT_LENGTH)
	let newMessages = newMessagesResult.messages
	let newContextTokens = await computeContextTokens(apiHandler, systemPrompt, newMessages)

	// 计算压缩前的有效 token 数（包括 systemPrompt，用于公平比较）
	const originalSystemPromptMessage: ApiMessage = { role: "user", content: systemPrompt }
	const originalEffectiveMessages = messages.filter((msg) => {
		// 过滤掉已有的 condenseParent 消息
		if (msg.condenseParent) {
			const existingSummaryIds = new Set<string>()
			for (const m of messages) {
				if (m.isSummary && m.condenseId) {
					existingSummaryIds.add(m.condenseId)
				}
			}
			if (existingSummaryIds.has(msg.condenseParent)) {
				return false
			}
		}
		return true
	})
	const originalContextBlocks = [originalSystemPromptMessage, ...originalEffectiveMessages].flatMap((message) =>
		typeof message.content === "string" ? [{ text: message.content, type: "text" as const }] : message.content,
	)
	const originalContextTokens = await apiHandler.countTokens(originalContextBlocks)

	// 检查压缩后上下文是否增长（使用公平的比较：都包括 systemPrompt）
	if (newContextTokens >= originalContextTokens) {
		console.warn(
			`[SWEBench-Condense] Context grew after compression: ${originalContextTokens} -> ${newContextTokens} tokens. This may happen if the summary is very long or few messages were compressed.`,
		)
		return { ...response, cost, error: "Context grew after compression, skipping" }
	}

	// 如果提供了 contextWindow，验证压缩后的上下文不超过可用上下文（考虑 buffer 和 maxTokens）
	if (contextWindow !== undefined) {
		const bufferTokens = Math.floor(contextWindow * SWEBENCH_TOKEN_BUFFER_PERCENTAGE)
		const reservedTokens = bufferTokens + (maxTokens ?? 0)
		const usableContextWindow = contextWindow - reservedTokens
		const targetAfterCondense = Math.floor(usableContextWindow * SWEBENCH_POST_CONDENSE_TARGET_UTILIZATION)

		if (newContextTokens > targetAfterCondense) {
			console.log(
				`[SWEBench-Condense] Post-condense context still large (${newContextTokens} tokens). Retrying with more aggressive keep policy (${SWEBENCH_AGGRESSIVE_TOOL_RESULTS_TO_KEEP} tool results, maxLen ${SWEBENCH_AGGRESSIVE_MAX_TOOL_RESULT_LENGTH}) to target <= ${targetAfterCondense}.`,
			)
			newMessagesResult = buildCondensedMessages(
				SWEBENCH_AGGRESSIVE_TOOL_RESULTS_TO_KEEP,
				SWEBENCH_AGGRESSIVE_MAX_TOOL_RESULT_LENGTH,
			)
			newMessages = newMessagesResult.messages
			newContextTokens = await computeContextTokens(apiHandler, systemPrompt, newMessages)

			// If we're still far above target, fall back to the more aggressive strategy.
			if (newContextTokens > targetAfterCondense) {
				const fallback = await applyFallbackCompressionStrategy(
					messages,
					apiHandler,
					prevContextTokens,
					contextWindow,
					maxTokens,
				)
				if (!fallback.error) {
					return {
						...fallback,
						cost: (fallback.cost ?? 0) + cost,
						summary,
						condenseId: fallback.condenseId ?? condenseId,
					}
				}
			}
		}

		if (newContextTokens > usableContextWindow) {
			const fallback = await applyFallbackCompressionStrategy(
				messages,
				apiHandler,
				prevContextTokens,
				contextWindow,
				maxTokens,
			)
			if (!fallback.error) {
				return {
					...fallback,
					cost: (fallback.cost ?? 0) + cost,
					summary,
					condenseId: fallback.condenseId ?? condenseId,
				}
			}
			return {
				...response,
				cost,
				error: `Compressed context (${newContextTokens}) exceeds usable context window (${usableContextWindow} after reserving ${reservedTokens} tokens)`,
			}
		}
	}

	console.log(
		`[SWEBench-Condense] Compressed ${messagesToSummarize.length} messages, produced ${newMessages.length} total messages (including summary) with ${SWEBENCH_TOOL_RESULTS_TO_KEEP} recent tool results`,
	)

	return { messages: newMessages, summary, cost, newContextTokens, condenseId }
}

/**
 * 判断错误是否不可恢复（不应该重试）
 */
function isUnrecoverableError(error: string): boolean {
	// 这些错误是正常的业务逻辑，不应该重试
	return (
		error === "Not enough messages to summarize" ||
		error === "Recently summarized, skipping" ||
		error === "Context grew after compression, skipping"
	)
}

/**
 * 降级压缩策略：当正常压缩失败时，使用更激进的方法
 * 1. 只保留第一条消息和最后几条消息
 * 2. 更激进地截断工具结果
 */
async function applyFallbackCompressionStrategy(
	messages: ApiMessage[],
	apiHandler: ApiHandler,
	prevContextTokens: number,
	contextWindow?: number,
	maxTokens?: number | null,
): Promise<SWEBenchSummarizeResponse> {
	console.log("[SWEBench-Condense] Applying fallback compression strategy")

	if (messages.length <= 3) {
		return {
			messages,
			summary: "",
			cost: 0,
			error: "Not enough messages for fallback compression",
		}
	}

	// 降级策略：只保留第一条消息和最后2条消息
	const keepIndices = new Set<number>([0, messages.length - 1])
	if (messages.length > 2) {
		keepIndices.add(messages.length - 2)
	}

	// 准备保留的消息（更激进的截断：只保留4000字符）
	const keepMessages: ApiMessage[] = []
	messages.forEach((msg, idx) => {
		if (keepIndices.has(idx)) {
			keepMessages.push(msg)
		}
	})

	const processedKeepMessages = prepareKeptMessages(keepMessages, 4000) // 更激进的截断

	// 创建简单的摘要消息
	const summaryMessage: ApiMessage = {
		role: "assistant",
		content: `[Context compressed using fallback strategy: ${messages.length - keepIndices.size} messages removed due to compression failure]`,
		ts: processedKeepMessages[0]?.ts ?? Date.now() - 1,
		isSummary: true,
		condenseId: crypto.randomUUID(),
	}

	// 构建新消息列表
	const newMessages: ApiMessage[] = []
	messages.forEach((msg, index) => {
		if (index === 0) {
			newMessages.push(msg) // 第一条消息保持不变
		} else if (keepIndices.has(index)) {
			// 使用处理后的保留消息
			const processedMsg = processedKeepMessages.find((_, i) => {
				let keepIdx = 0
				for (let j = 0; j < messages.length; j++) {
					if (keepIndices.has(j)) {
						if (j === index) return keepIdx === i
						keepIdx++
					}
				}
				return false
			})
			newMessages.push(processedMsg || msg)
		} else if (index === 1) {
			// 在第一个被移除的消息位置插入摘要
			newMessages.push(summaryMessage)
		}
	})

	// 如果摘要还没有插入，插入到第一个被移除的消息之前
	if (!newMessages.some((msg) => msg.isSummary)) {
		let insertPos = 1
		for (let i = 1; i < messages.length; i++) {
			if (!keepIndices.has(i)) {
				insertPos = i
				break
			}
		}
		newMessages.splice(insertPos, 0, summaryMessage)
	}

	// 计算新的上下文 token 数
	const contextBlocks = newMessages.flatMap((message) =>
		typeof message.content === "string" ? [{ text: message.content, type: "text" as const }] : message.content,
	)
	const newContextTokens = await apiHandler.countTokens(contextBlocks)

	console.log(
		`[SWEBench-Condense] Fallback compression: removed ${messages.length - keepIndices.size} messages, context reduced from ${prevContextTokens} to ${newContextTokens} tokens`,
	)

	return {
		messages: newMessages,
		summary: summaryMessage.content as string,
		cost: 0,
		newContextTokens,
		condenseId: summaryMessage.condenseId,
	}
}

/**
 * 检查是否需要触发 SWE-bench 上下文压缩
 */
export function shouldTriggerSWEBenchCondense(
	totalTokens: number,
	contextWindow: number,
	lastMessageTokens: number,
	maxTokens?: number | null,
): boolean {
	const prevContextTokens = totalTokens + lastMessageTokens
	// 应用 token buffer 和 maxTokens：从可用上下文中减去这些值
	const bufferTokens = Math.floor(contextWindow * SWEBENCH_TOKEN_BUFFER_PERCENTAGE)
	const reservedTokens = bufferTokens + (maxTokens ?? 0)
	const usableContextWindow = contextWindow - reservedTokens
	const contextPercent = usableContextWindow > 0 ? (100 * prevContextTokens) / usableContextWindow : 100
	return contextPercent >= SWEBENCH_CONDENSE_THRESHOLD
}

/**
 * SWE-bench 上下文管理主入口
 *
 * @param options - 上下文管理选项
 * @returns 管理结果
 */
export type SWEBenchContextManagementOptions = {
	messages: ApiMessage[]
	totalTokens: number
	contextWindow: number
	maxTokens?: number | null
	apiHandler: ApiHandler
	systemPrompt: string
	taskId: string
	useNativeTools?: boolean
	stateMachine?: {
		getState: () => {
			phase: string
			testsRunCount: number
			modificationCount: number
			readCallsCount: number
			testCallsCount: number
			attemptCompletionCount: number
			modifiedFiles: string[]
		}
	}
}

export type SWEBenchContextManagementResult = SWEBenchSummarizeResponse & {
	prevContextTokens: number
	triggered: boolean
}

export async function manageSWEBenchContext({
	messages,
	totalTokens,
	contextWindow,
	maxTokens,
	apiHandler,
	systemPrompt,
	taskId,
	useNativeTools,
	stateMachine,
}: SWEBenchContextManagementOptions): Promise<SWEBenchContextManagementResult> {
	// 估算最后一条消息的 token 数
	const lastMessage = messages[messages.length - 1]
	const lastMessageContent = lastMessage?.content
	let lastMessageTokens = 0

	if (Array.isArray(lastMessageContent)) {
		lastMessageTokens = await apiHandler.countTokens(lastMessageContent)
	} else if (typeof lastMessageContent === "string") {
		lastMessageTokens = await apiHandler.countTokens([{ type: "text", text: lastMessageContent }])
	}

	const prevContextTokens = totalTokens + lastMessageTokens

	// 应用 token buffer 和 maxTokens 来计算可用上下文
	const bufferTokens = Math.floor(contextWindow * SWEBENCH_TOKEN_BUFFER_PERCENTAGE)
	const reservedTokens = bufferTokens + (maxTokens ?? 0)
	const usableContextWindow = contextWindow - reservedTokens

	// 检查是否需要压缩（考虑 buffer 和 maxTokens）
	if (!shouldTriggerSWEBenchCondense(totalTokens, contextWindow, lastMessageTokens, maxTokens)) {
		return {
			messages,
			summary: "",
			cost: 0,
			prevContextTokens,
			triggered: false,
		}
	}

	// 计算实际使用百分比（基于原始 contextWindow，用于日志）
	const actualContextPercent = (100 * prevContextTokens) / contextWindow
	const usableContextPercent = usableContextWindow > 0 ? (100 * prevContextTokens) / usableContextWindow : 100
	console.log(
		`[SWEBench-Condense] Triggering compression at ${actualContextPercent.toFixed(1)}% context usage (${usableContextPercent.toFixed(1)}% of usable context after ${((100 * reservedTokens) / contextWindow).toFixed(1)}% reserved)`,
	)

	// 执行压缩（带错误处理和重试）
	let result: SWEBenchSummarizeResponse | undefined
	let retryCount = 0
	const maxRetries = 2

	while (retryCount <= maxRetries) {
		try {
			const attemptResult = await summarizeSWEBenchConversation(
				messages,
				apiHandler,
				systemPrompt,
				taskId,
				prevContextTokens,
				useNativeTools,
				contextWindow,
				maxTokens,
				stateMachine,
			)

			// 如果成功或遇到不可恢复的错误，退出循环
			if (!attemptResult.error || isUnrecoverableError(attemptResult.error)) {
				result = attemptResult
				break
			}

			// 如果是可恢复的错误，记录并重试
			if (retryCount < maxRetries) {
				console.warn(
					`[SWEBench-Condense] Compression failed with recoverable error: ${attemptResult.error}. Retrying (${retryCount + 1}/${maxRetries})...`,
				)
				retryCount++
				// 等待一小段时间再重试
				await new Promise((resolve) => setTimeout(resolve, 1000))
				continue
			}

			// 达到最大重试次数，使用降级策略
			console.warn(`[SWEBench-Condense] Compression failed after ${maxRetries} retries. Using fallback strategy.`)
			result = await applyFallbackCompressionStrategy(
				messages,
				apiHandler,
				prevContextTokens,
				contextWindow,
				maxTokens,
			)
			break
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			console.error(`[SWEBench-Condense] Compression threw exception: ${errorMessage}`, error)

			if (retryCount < maxRetries) {
				retryCount++
				console.warn(`[SWEBench-Condense] Retrying after exception (${retryCount}/${maxRetries})...`)
				await new Promise((resolve) => setTimeout(resolve, 1000))
				continue
			}

			// 达到最大重试次数，使用降级策略
			console.warn(
				`[SWEBench-Condense] Compression failed after ${maxRetries} retries due to exception. Using fallback strategy.`,
			)
			result = await applyFallbackCompressionStrategy(
				messages,
				apiHandler,
				prevContextTokens,
				contextWindow,
				maxTokens,
			)
			break
		}
	}

	// 如果所有尝试都失败，返回原始消息（不应该发生，但防御性编程）
	if (!result) {
		console.error("[SWEBench-Condense] All compression attempts failed, returning original messages")
		result = {
			messages,
			summary: "",
			cost: 0,
			error: "All compression attempts failed",
		}
	}

	return {
		...result,
		prevContextTokens,
		triggered: true,
	}
}
