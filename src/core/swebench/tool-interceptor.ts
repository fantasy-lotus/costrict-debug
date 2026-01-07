/**
 * SWE-bench Tool Interceptor
 *
 * Integrates the SWE-bench state machine with the CoStrict tool system.
 * This interceptor is activated when running in SWE-bench mode and enforces
 * the strict workflow with repository-aware validation and flexible exploration.
 */

import type { ToolName } from "@roo-code/types"
import {
	SWEBenchStateMachine,
	type SWEBenchState,
	type SWEBenchPhase,
	type ValidationResult,
	isTestCommand,
} from "./state-machine"
import { applyPathMapping } from "./path-mapper"
import { generateInstanceTestDiscoveryGuidance } from "./instance-prompts"
import type { RepositoryConfig } from "./repository-config"

interface ToolExecutionRecord {
	toolName: ToolName
	params: Record<string, unknown>
	output?: string
	timestamp: number
	success: boolean
	guidance?: string // 失败时的指导信息
}

interface OutputRecord {
	content: string
	timestamp: number
	toolName: ToolName
	params: Record<string, unknown>
}

export interface LoopDetectionResult {
	detected: boolean
	type?: LoopType
	severity?: "low" | "medium" | "high"
	message?: string
}

export type LoopType = "output" | "stagnation" | "failure" | "success"

export interface SWEBenchInterceptorConfig {
	/** Whether to enforce strict mode (block tools) or just warn */
	strictMode: boolean
	/** Callback for logging state transitions */
	onStateChange?: (oldState: SWEBenchState, newState: SWEBenchState) => void
	/** Callback for logging blocked tool attempts */
	onToolBlocked?: (toolName: ToolName, reason: string) => void
	/** Callback for providing guidance after tool execution (e.g., second jinnang) */
	onToolGuidance?: (toolName: ToolName, guidance: string) => void
	/** Callback for logging general messages */
	onLog?: (message: string) => void
}

const DEFAULT_CONFIG: SWEBenchInterceptorConfig = {
	strictMode: true,
}

/**
 * Global interceptor instance for the current SWE-bench session
 */
let activeInterceptor: SWEBenchToolInterceptor | null = null

export class SWEBenchToolInterceptor {
	private stateMachine: SWEBenchStateMachine
	private config: SWEBenchInterceptorConfig
	private executionHistory: ToolExecutionRecord[] = []
	private outputHistory: OutputRecord[] = []
	private readonly MAX_HISTORY_SIZE = 50
	private readonly MAX_OUTPUT_HISTORY_SIZE = 20
	private readonly MIN_OUTPUT_CHARS_FOR_LOOP_DETECTION = 80
	private readonly MIN_OUTPUT_CHARS_FOR_SEVERE_LOOP_DETECTION = 200
	private readonly MAX_REPEATED_FAILURES = 3 // 最多允许3次相同的失败操作
	private loopDetectionCount = 0 // 循环检测触发次数
	private lastToolExecutionTime = Date.now() // 最后一次工具执行时间
	private consecutiveApplyDiffCount = 0
	private readonly MAX_CONSECUTIVE_APPLY_DIFF = 3
	private secondJinnangShown = false // 第二个锦囊是否已显示

	private normalizeCommandForKey(command: unknown): string {
		if (typeof command !== "string") {
			return ""
		}
		return command.replace(/\s+/g, " ").trim()
	}

	private stripAnsiSequences(text: string): string {
		// eslint-disable-next-line no-control-regex
		return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
	}

	private extractExitCodeFromExecuteCommandOutput(output: string): number | null {
		const match = output.match(/Exit code:\s*(\d+)/i)
		if (!match) {
			return null
		}
		const value = Number(match[1])
		return Number.isFinite(value) ? value : null
	}

	private extractExecuteCommandOutputSection(output: string): string {
		const marker = "\nOutput:\n"
		const idx = output.indexOf(marker)
		if (idx >= 0) {
			return output.slice(idx + marker.length)
		}
		return output
	}

	private normalizeStderrForExecuteCommandKey(output: string, maxChars: number): string {
		let stderr = this.extractExecuteCommandOutputSection(output)
		stderr = this.stripAnsiSequences(stderr)
		stderr = stderr
			.replace(/\bpid\s+\d+\b/gi, "pid <n>")
			.replace(/0x[0-9a-f]+/gi, "0x<hex>")
			.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<date>")
			.replace(/\b\d{2}:\d{2}:\d{2}\b/g, "<time>")
			.replace(/\b\d+\.\d+s\b/g, "<duration>")

		// Lowercase to reduce spurious diffs (e.g., platform-specific capitalization)
		return this.normalizeOutputForSignature(stderr.toLowerCase(), maxChars)
	}

	private normalizeOutputForSignature(content: string, maxChars: number): string {
		const normalized = content.replace(/\s+/g, " ").trim()
		return normalized.length > maxChars ? normalized.substring(0, maxChars) : normalized
	}

	private buildOutputSignature(record: OutputRecord, maxChars: number, minChars: number): string | null {
		const normalized =
			record.toolName === "execute_command"
				? this.normalizeStderrForExecuteCommandKey(record.content, maxChars)
				: this.normalizeOutputForSignature(record.content, maxChars)
		if (normalized.length < minChars) {
			return null
		}

		const key =
			record.toolName === "execute_command"
				? JSON.stringify({
						toolName: record.toolName,
						command: this.normalizeCommandForKey(record.params.command),
						exit_code: this.extractExitCodeFromExecuteCommandOutput(record.content),
						normalized_stderr: this.normalizeStderrForExecuteCommandKey(record.content, 200),
					})
				: record.toolName === "read_file"
					? JSON.stringify({
							toolName: record.toolName,
							path: this.extractReadFileKeyPath(record.params),
							regex: record.params.regex,
							query: record.params.query,
						})
					: record.toolName === "search_files"
						? JSON.stringify({
								toolName: record.toolName,
								path: record.params.path,
								regex: record.params.regex,
								query: record.params.query,
							})
						: JSON.stringify({
								toolName: record.toolName,
								path: record.params.path,
								regex: record.params.regex,
								query: record.params.query,
								command: record.params.command,
							})

		return `${key}|${normalized}`
	}

	private resetApplyDiffStreak(): void {
		this.consecutiveApplyDiffCount = 0
		this.secondJinnangShown = false
	}

	/**
	 * Called after context compression/condense to avoid stale counters spanning summaries.
	 */
	resetAfterContextCompression(): void {
		this.resetApplyDiffStreak()
	}

	private isTargetedDjangoRuntestsCommand(command: string): boolean {
		// Allow targeted labels like: invalid_models_tests.test_relative_fields.ComplexClashTests.test_clash_parent_link
		// This is safer than allowing broad runs like "./runtests.py" with no labels.
		if (!/\bruntests\.py\b/i.test(command)) {
			return false
		}

		// Heuristic: a dotted label token present (and not an option) indicates a targeted test selection.
		const tokens = command.split(/\s+/).filter(Boolean)
		return tokens.some((t) => !t.startsWith("-") && t.includes("."))
	}

	constructor(config: Partial<SWEBenchInterceptorConfig> = {}, instanceId?: string) {
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.stateMachine = new SWEBenchStateMachine(undefined, instanceId)
	}

	/**
	 * Get repository-specific test guidance for the current instance
	 */
	private getRepositorySpecificGuidance(instanceId: string): string {
		try {
			return generateInstanceTestDiscoveryGuidance(instanceId)
		} catch (error) {
			console.warn("[SWEBench] Failed to get repository-specific guidance:", error)
			return ""
		}
	}

	/**
	 * Apply path mapping to tool parameters for SWE-bench mode
	 * Maps /testbed/* paths to /workspace/repo/* paths
	 */
	applyPathMappingToParams(
		toolName: ToolName,
		params?: Record<string, unknown>,
	): Record<string, unknown> | undefined {
		if (!params) {
			return params
		}

		const mappedParams = { ...params }

		// Apply path mapping based on tool type
		switch (toolName) {
			case "read_file":
				// Handle both legacy path param and files array
				if (typeof mappedParams.path === "string") {
					mappedParams.path = applyPathMapping(mappedParams.path, true)
				}
				if (typeof mappedParams.args === "string") {
					// For XML args, we need to parse and map paths within the XML
					// This is more complex, but for now we'll handle the common case
					mappedParams.args = this.mapPathsInXmlArgs(mappedParams.args)
				}
				break

			case "apply_diff":
				if (typeof mappedParams.path === "string") {
					mappedParams.path = applyPathMapping(mappedParams.path, true)
				}
				if (typeof mappedParams.args === "string") {
					mappedParams.args = this.mapPathsInXmlArgs(mappedParams.args)
				}
				break

			case "write_to_file":
				if (typeof mappedParams.path === "string") {
					mappedParams.path = applyPathMapping(mappedParams.path, true)
				}
				break

			case "search_and_replace":
			case "search_replace":
				if (typeof mappedParams.path === "string") {
					mappedParams.path = applyPathMapping(mappedParams.path, true)
				}
				if (typeof mappedParams.file_path === "string") {
					mappedParams.file_path = applyPathMapping(mappedParams.file_path, true)
				}
				break

			case "list_files":
				if (typeof mappedParams.path === "string") {
					mappedParams.path = applyPathMapping(mappedParams.path, true)
				}
				break

			case "search_files":
				if (typeof mappedParams.path === "string") {
					mappedParams.path = applyPathMapping(mappedParams.path, true)
				}
				break

			// For execute_command, we could potentially map paths in the command string,
			// but that's more complex and risky, so we'll skip it for now
		}

		return mappedParams
	}

	/**
	 * Map paths within XML args (simplified implementation)
	 */
	private mapPathsInXmlArgs(xmlArgs: string): string {
		// Simple regex-based replacement for common path patterns in XML
		// This handles <path>/testbed/...</path> patterns
		return xmlArgs.replace(
			/<path>\/testbed(\/[^<]*)?<\/path>/g,
			(_, suffix) => `<path>/workspace/repo${suffix || ""}</path>`,
		)
	}

	/**
	 * 获取连续重复的相同操作次数（无论成功失败）
	 */
	private getConsecutiveRepeats(toolName: ToolName, params: Record<string, unknown>): number {
		if (this.executionHistory.length === 0) {
			return 0
		}

		// execute_command: (command, exit_code, normalized_stderr) as key
		if (toolName === "execute_command") {
			const currentCommand = this.normalizeCommandForKey(params.command)
			const last = this.executionHistory[this.executionHistory.length - 1]
			if (last?.toolName !== "execute_command") {
				return 0
			}
			if (this.normalizeCommandForKey(last.params.command) !== currentCommand) {
				return 0
			}

			const lastKey = JSON.stringify({
				command: currentCommand,
				exit_code: last.output ? this.extractExitCodeFromExecuteCommandOutput(last.output) : null,
				normalized_stderr: last.output ? this.normalizeStderrForExecuteCommandKey(last.output, 200) : "",
			})

			let count = 0
			for (let i = this.executionHistory.length - 1; i >= 0; i--) {
				const record = this.executionHistory[i]
				if (record.toolName !== "execute_command") {
					break
				}
				if (this.normalizeCommandForKey(record.params.command) !== currentCommand) {
					break
				}
				const recordKey = JSON.stringify({
					command: currentCommand,
					exit_code: record.output ? this.extractExitCodeFromExecuteCommandOutput(record.output) : null,
					normalized_stderr: record.output
						? this.normalizeStderrForExecuteCommandKey(record.output, 200)
						: "",
				})
				if (recordKey !== lastKey) {
					break
				}
				count++
			}
			return count
		}

		// read_file/search_files: (path/regex/query) as key, output as supporting evidence
		const last = this.executionHistory[this.executionHistory.length - 1]
		if (!last || last.toolName !== toolName || !this.isSimilarParams(toolName, last.params, params)) {
			return 0
		}

		const baseline = last.output ? this.normalizeOutputForSignature(last.output, 200) : ""
		const shouldUseOutputEvidence = baseline.length >= this.MIN_OUTPUT_CHARS_FOR_LOOP_DETECTION

		let count = 0
		for (let i = this.executionHistory.length - 1; i >= 0; i--) {
			const record = this.executionHistory[i]
			if (record.toolName !== toolName || !this.isSimilarParams(toolName, record.params, params)) {
				break
			}
			if (shouldUseOutputEvidence) {
				const candidate = record.output ? this.normalizeOutputForSignature(record.output, 200) : ""
				if (candidate !== baseline) {
					break
				}
			}
			count++
		}
		return count
	}

	/**
	 * 检测输出循环（重复输出相同内容）
	 */
	private detectOutputLoop(): boolean {
		if (this.outputHistory.length < 5) {
			return false
		}

		// 获取最近的输出记录
		const recentOutputs = this.outputHistory.slice(-10)

		// 检查是否有大量相似的输出
		const outputSignatures = recentOutputs
			.map((record) => this.buildOutputSignature(record, 200, this.MIN_OUTPUT_CHARS_FOR_LOOP_DETECTION))
			.filter((sig): sig is string => Boolean(sig))

		if (outputSignatures.length < 8) {
			return false
		}

		const uniqueSignatures = new Set(outputSignatures)
		return uniqueSignatures.size <= 2
	}

	/**
	 * 检测严重的输出循环（仅用于VERIFY阶段）
	 * 更严格的标准，只检测真正的重复内容
	 */
	private detectSevereOutputLoop(): boolean {
		if (this.outputHistory.length < 8) {
			return false
		}

		// 获取最近的输出记录
		const recentOutputs = this.outputHistory.slice(-12)

		// 检查是否有完全相同的输出
		const outputSignatures = recentOutputs
			.map((record) => this.buildOutputSignature(record, 500, this.MIN_OUTPUT_CHARS_FOR_SEVERE_LOOP_DETECTION))
			.filter((sig): sig is string => Boolean(sig))

		if (outputSignatures.length < 10) {
			return false
		}

		const uniqueSignatures = new Set(outputSignatures)
		return uniqueSignatures.size <= 1
	}

	/**
	 * 检测长时间停滞（无工具调用）
	 */
	private detectStagnation(): boolean {
		const currentTime = Date.now()
		const stagnationThreshold = 5 * 60 * 1000 // 5分钟

		return currentTime - this.lastToolExecutionTime > stagnationThreshold
	}

	/**
	 * 检测是否存在循环行为
	 */
	private detectLoop(toolName: ToolName, params?: Record<string, unknown>): string | null {
		const currentPhase: SWEBenchPhase = this.stateMachine.getState().phase

		const consecutiveFailures = this.getConsecutiveFailures(toolName, params || {})
		const consecutiveRepeats = this.getConsecutiveRepeats(toolName, params || {})

		// In VERIFY phase, be much less aggressive with loop detection
		// Only block if it's clearly problematic behavior
		if (currentPhase === "VERIFY") {
			// Only detect severe output loops in VERIFY phase
			if (this.detectSevereOutputLoop()) {
				return `🔄 OUTPUT LOOP DETECTED: You are repeating identical content.

🎯 RECOVERY ACTION: Call attempt_completion to submit your solution.

💡 If tests are passing and you've implemented the fix, complete the task now.`
			}

			// Don't apply other loop detection in VERIFY phase
			if (toolName === "execute_command" && consecutiveRepeats >= 3) {
				return `🔄 REPETITION DETECTED: You have run the same test command ${consecutiveRepeats} times consecutively.

🎯 If tests are passing consistently, you should:
   • Call attempt_completion to submit your solution
   • Include a summary of what was fixed and test results

⚠️  Continuing to re-run the same passing tests is not productive and may lead to timeout.

💡 Check the current phase guidance for completion criteria.

Recent operations: ${this.executionHistory
					.slice(-consecutiveRepeats)
					.map(
						(op) =>
							`${op.toolName}(${this.summarizeParams(op.params)}) - ${op.success ? "SUCCESS" : "FAILED"}`,
					)
					.join(", ")}`
			}
			return null
		}

		// Normal loop detection for other phases
		// 检查输出循环（优先级最高）
		if (this.detectOutputLoop()) {
			return `🔄 OUTPUT LOOP DETECTED: You are repeating the same output content.

🎯 RECOVERY ACTIONS:
   1. Stop reading the same file repeatedly
   2. Move to the next phase based on your current progress
   3. If you've identified the problem, start implementing the fix
   4. If tests are passing, call attempt_completion

⚠️  Continuing to output the same content is not productive.

💡 Current phase: ${currentPhase}
   Check the phase guidance for what you should do next.

Recent output pattern detected: Repeating similar content ${this.outputHistory.length} times`
		}

		// 检查长时间停滞
		if (this.detectStagnation()) {
			let phaseGuidance = ""
			if (currentPhase === "ANALYZE") {
				phaseGuidance = `
   • If you've found the tests, run them to understand the problem
   • If tests are failing as expected, move to MODIFY phase
   • Focus on implementing the fix in source code`
			} else if (currentPhase === "MODIFY") {
				phaseGuidance = `
   • Apply your planned code changes
   • Use apply_diff or search_and_replace to modify source files
   • Focus on the specific issue described in the problem statement`
			} else if (currentPhase === "VERIFY") {
				phaseGuidance = `
   • Re-run the FAIL_TO_PASS tests to verify your fix
   • If tests pass, call attempt_completion
   • If tests still fail, return to MODIFY phase`
			}

			return `⏰ STAGNATION DETECTED: No tool execution for over 5 minutes.

🎯 RECOVERY ACTIONS based on current phase (${currentPhase}):${phaseGuidance}

⚠️  Take action now to avoid timeout.`
		}

		// 检测失败循环
		if (consecutiveFailures >= this.MAX_REPEATED_FAILURES) {
			// 增加循环计数器
			this.loopDetectionCount = (this.loopDetectionCount || 0) + 1

			// 如果循环检测触发多次，提供更强的指导
			const isRepeatedLoop = this.loopDetectionCount >= 2

			return `🔄 LOOP DETECTED (${this.loopDetectionCount}${isRepeatedLoop ? " - CRITICAL" : ""}): You have attempted the same operation ${consecutiveFailures} times consecutively with failures.

${
	isRepeatedLoop
		? `🚨 CRITICAL: This is the ${this.loopDetectionCount}th loop detection. You MUST change your approach completely.

🔄 MANDATORY STRATEGY CHANGE:
   • STOP the current approach entirely
   • Try a completely different strategy or method
   • Consider that your assumptions might be wrong
   • Review the current phase guidance for alternative approaches

`
		: ""
}🎯 SWE-bench Task Reminder:
   • Tests may not exist yet or be incomplete
   • Focus on understanding the problem from description and error messages
   • Look for clues like "KeyError" or "missing parameter" to understand expected functionality
   • You may add test cases if they help validate your solution

💡 Strategy suggestions:
1. Try different search keywords or broader scope
2. Check command correctness or try alternative test runners
3. Review project documentation for correct approach
4. Focus on the issue description and modify source code, not tests

Recent failed operations: ${this.executionHistory
				.slice(-consecutiveFailures)
				.map((op) => `${op.toolName}(${this.summarizeParams(op.params)})`)
				.join(", ")}`
		}

		// 检测成功循环（在非VERIFY阶段的重复操作）
		// Note: VERIFY阶段的重复测试检测已经在第270-300行的VERIFY分支中处理并返回
		// 所以这里只处理 ANALYZE 和 MODIFY 阶段的重复操作
		if (toolName === "execute_command" && consecutiveRepeats >= 3) {
			return `🔄 REPETITION DETECTED: You have run the same test command ${consecutiveRepeats} times consecutively.

🎯 Consider:
   • If tests are passing, move to the next phase
   • If tests are failing, try a different approach
   • Review the current phase guidance for next steps

⚠️  Continuing to re-run the same command is not productive and may lead to timeout.

💡 Current phase: ${currentPhase}
   Check the phase guidance for what you should do next.

Recent operations: ${this.executionHistory
				.slice(-consecutiveRepeats)
				.map(
					(op) => `${op.toolName}(${this.summarizeParams(op.params)}) - ${op.success ? "SUCCESS" : "FAILED"}`,
				)
				.join(", ")}`
		}

		return null
	}

	/**
	 * 获取连续失败的相同操作次数
	 */
	private getConsecutiveFailures(toolName: ToolName, params: Record<string, unknown>): number {
		if (this.executionHistory.length === 0) {
			return 0
		}

		if (toolName === "execute_command") {
			const currentCommand = this.normalizeCommandForKey(params.command)
			const last = this.executionHistory[this.executionHistory.length - 1]
			if (last?.toolName !== "execute_command" || last.success) {
				return 0
			}
			if (this.normalizeCommandForKey(last.params.command) !== currentCommand) {
				return 0
			}

			const lastKey = JSON.stringify({
				command: currentCommand,
				exit_code: last.output ? this.extractExitCodeFromExecuteCommandOutput(last.output) : null,
				normalized_stderr: last.output ? this.normalizeStderrForExecuteCommandKey(last.output, 200) : "",
			})

			let count = 0
			for (let i = this.executionHistory.length - 1; i >= 0; i--) {
				const record = this.executionHistory[i]
				if (record.toolName !== "execute_command" || record.success) {
					break
				}
				if (this.normalizeCommandForKey(record.params.command) !== currentCommand) {
					break
				}
				const recordKey = JSON.stringify({
					command: currentCommand,
					exit_code: record.output ? this.extractExitCodeFromExecuteCommandOutput(record.output) : null,
					normalized_stderr: record.output
						? this.normalizeStderrForExecuteCommandKey(record.output, 200)
						: "",
				})
				if (recordKey !== lastKey) {
					break
				}
				count++
			}
			return count
		}

		const last = this.executionHistory[this.executionHistory.length - 1]
		if (
			!last ||
			last.toolName !== toolName ||
			!this.isSimilarParams(toolName, last.params, params) ||
			last.success
		) {
			return 0
		}

		const baseline = last.output ? this.normalizeOutputForSignature(last.output, 200) : ""
		const shouldUseOutputEvidence = baseline.length >= this.MIN_OUTPUT_CHARS_FOR_LOOP_DETECTION

		let count = 0
		for (let i = this.executionHistory.length - 1; i >= 0; i--) {
			const record = this.executionHistory[i]
			if (
				record.toolName !== toolName ||
				!this.isSimilarParams(toolName, record.params, params) ||
				record.success
			) {
				break
			}
			if (shouldUseOutputEvidence) {
				const candidate = record.output ? this.normalizeOutputForSignature(record.output, 200) : ""
				if (candidate !== baseline) {
					break
				}
			}
			count++
		}
		return count
	}

	/**
	 * 比较两个参数对象是否相似（用于循环检测）
	 */
	private extractReadFileKeyPath(params: Record<string, unknown>): string {
		if (typeof params.path === "string") {
			return params.path
		}
		const files = params.files
		if (Array.isArray(files)) {
			const paths = files
				.map((f) => (f && typeof f === "object" && "path" in f ? (f as any).path : undefined))
				.filter((p): p is string => typeof p === "string")
				.map((p) => p.trim())
				.filter(Boolean)
				.sort()
			if (paths.length > 0) {
				return paths.join("|")
			}
		}
		if (typeof params.args === "string") {
			const matches = [...params.args.matchAll(/<path>([^<]+)<\/path>/g)]
			const paths = matches
				.map((m) => String(m[1]).trim())
				.filter(Boolean)
				.sort()
			if (paths.length > 0) {
				return paths.join("|")
			}
		}
		return ""
	}

	private isSimilarParams(
		toolName: ToolName,
		params1: Record<string, unknown>,
		params2: Record<string, unknown>,
	): boolean {
		if (toolName === "read_file") {
			const key1 = JSON.stringify({
				path: this.extractReadFileKeyPath(params1),
				query: params1.query,
				regex: params1.regex,
			})
			const key2 = JSON.stringify({
				path: this.extractReadFileKeyPath(params2),
				query: params2.query,
				regex: params2.regex,
			})
			return key1 === key2
		}

		if (toolName === "search_files") {
			const key1 = JSON.stringify({
				path: params1.path,
				regex: params1.regex,
				query: params1.query,
			})
			const key2 = JSON.stringify({
				path: params2.path,
				regex: params2.regex,
				query: params2.query,
			})
			return key1 === key2
		}

		// Default: conservative key to avoid unintended cross-tool grouping.
		const key1 = JSON.stringify({
			path: params1.path,
			regex: params1.regex,
			query: params1.query,
			command: params1.command,
		})
		const key2 = JSON.stringify({
			path: params2.path,
			regex: params2.regex,
			query: params2.query,
			command: params2.command,
		})
		return key1 === key2
	}

	/**
	 * 简化参数显示（用于日志）
	 */
	private summarizeParams(params: Record<string, unknown>): string {
		const key = params.path || params.regex || params.query || params.command
		return key ? String(key).substring(0, 50) : "unknown"
	}

	/**
	 * 检测是否是单个测试命令（而不是测试套件）
	 */
	private isIndividualTestCommand(command?: string): boolean {
		if (!command) return false

		// 检测单个测试方法的模式
		const individualTestPatterns = [
			/pytest.*::\w+::\w+$/i, // pytest path::class::method
			/python.*-m.*pytest.*::\w+$/i, // python -m pytest path::method
			/python.*-c.*test_\w+/i, // python -c with single test
		]

		return individualTestPatterns.some((pattern) => pattern.test(command))
	}

	/**
	 * 判断操作是否成功
	 */
	private isOperationSuccessful(toolName: ToolName, output?: string): boolean {
		if (!output) return false

		switch (toolName) {
			case "search_files":
				return !output.includes("Found 0 results")
			case "execute_command": {
				// Check for various error indicators (case insensitive)
				const lowerOutput = output.toLowerCase()
				return (
					!lowerOutput.includes("error") &&
					!lowerOutput.includes("attributeerror") &&
					!lowerOutput.includes("failed") &&
					!lowerOutput.includes("exception") &&
					!lowerOutput.includes("no module named")
				)
			}
			case "read_file":
				return !output.includes("No such file") && !output.includes("not found")
			default:
				return true
		}
	}

	/**
	 * Validate tool use (legacy format for backward compatibility)
	 * @returns null if allowed, error message if blocked
	 */
	validateToolUse(toolName: ToolName, params?: Record<string, unknown>): string | null {
		return this.validateToolUseInternal(toolName, params)
	}

	/**
	 * Validate tool use with detailed result information
	 */
	validateToolUseDetailed(toolName: ToolName, params?: Record<string, unknown>): ValidationResult {
		const errorMessage = this.validateToolUseInternal(toolName, params)

		return {
			allowed: errorMessage === null,
			reason: errorMessage || undefined,
			severity: errorMessage ? "error" : "info",
		}
	}

	/**
	 * Legacy method name for backward compatibility
	 * @returns null if allowed, error message if blocked
	 */
	validateToolUseLegacy(toolName: ToolName, params?: Record<string, unknown>): string | null {
		return this.validateToolUse(toolName, params)
	}

	/**
	 * Internal validation method (legacy compatibility)
	 * @returns null if allowed, error message if blocked
	 */
	private validateToolUseInternal(toolName: ToolName, params?: Record<string, unknown>): string | null {
		if (toolName === "apply_diff" && this.consecutiveApplyDiffCount >= this.MAX_CONSECUTIVE_APPLY_DIFF) {
			this.resetApplyDiffStreak()
			const guidance = this.getApplyDiffJinnangGuidance()
			this.config.onToolBlocked?.(toolName, guidance)
			return guidance
		}

		// attempt_completion should not be blocked by output-loop detection.
		// We only enforce the state-machine rule here (e.g. MODIFY phase not allowed).
		if (toolName === "attempt_completion") {
			const blockReason = this.stateMachine.getBlockReason(toolName)
			if (blockReason) {
				this.config.onToolBlocked?.(toolName, blockReason)
				return this.config.strictMode ? blockReason : null
			}
			return null
		}

		// Validate write_to_file usage
		if (toolName === "write_to_file") {
			const currentPhase = this.stateMachine.getState().phase

			// Block write_to_file in ANALYZE phase
			if (currentPhase === "ANALYZE") {
				return `⛔ write_to_file is BLOCKED in ANALYZE phase.

💡 **Guidance:**
• In ANALYZE phase, focus on understanding the problem and running tests
• Use \`apply_diff\` for code/test modifications (more accurate than write_to_file)
• \`write_to_file\` is only available in MODIFY/VERIFY phases for creating utility scripts/tools

**Next steps:**
• Continue exploring the codebase and running tests
• When ready to modify code, the phase will transition to MODIFY automatically`
			}

			// In MODIFY/VERIFY phases, allow write_to_file but provide guidance via callback
			// (not blocking, just informational)
			const filePath = params?.path as string | undefined
			if (filePath) {
				const isCodeFile = /\.(py|js|ts|java|cpp|c|h|hpp|go|rs|rb|php|swift|kt|scala|r|m|mm)$/i.test(filePath)
				const isTestFile = /test|spec|__tests__/i.test(filePath)

				if (isCodeFile || isTestFile) {
					const guidance = `💡 **Tool Usage Recommendation:**

You're using \`write_to_file\` to modify a ${isTestFile ? "test" : "code"} file. 

**Recommendation:**
• Prefer \`apply_diff\` for modifying code/test files (more accurate and preserves context)
• \`write_to_file\` is better suited for creating new utility scripts/tools (e.g., run_p2p_tests.py)
• \`apply_diff\` provides better diff tracking and is the preferred method for code modifications

**Note:** This is allowed, but \`apply_diff\` is recommended for better accuracy when editing existing files.`

					// Provide guidance via callback (non-blocking)
					this.config.onToolGuidance?.(toolName, guidance)
				}
			}
		}

		// Note: Test file modifications are now ALLOWED in SWE-bench mode
		// Reason: Some SWE-bench tasks require adding new test cases (e.g., cm6, cm9 in astropy)
		// The test_patch in evaluation may add tests, and agent needs to anticipate this
		//
		// Previous restriction removed - agent can now:
		// - Add new test cases
		// - Add test data to existing test dictionaries
		// - Modify test files as needed to complete the task

		// 检查循环（优先级高于项目探索检查，避免循环被掩盖）
		const loopError = this.detectLoop(toolName, params)
		if (loopError) {
			return loopError
		}

		// 禁止在 SWE-bench 模式下切换 git 分支（会导致评测环境偏离当前 instance）
		if (toolName === "execute_command" && params?.command) {
			const command = String(params.command)
			const parts = command.split(/\s*(?:&&|;|\|\|)\s*/)
			for (const part of parts) {
				const trimmed = part.trim()
				if (!trimmed) continue

				// Block all `git switch` (branch switching) commands
				if (/(?:^|\s)git\s+switch\b/i.test(trimmed)) {
					return `🚫 BLOCKED: Do NOT switch git branches in SWE-bench mode.

The task may require running tests, but they might not exist yet or may be incomplete.
Focus on understanding the problem and implementing the fix based on the problem description.

Attempted command: ${trimmed}`
				}

				// Block `git checkout <branch>` style branch switches.
				// Allow only file restore usage that includes "--" (e.g. "git checkout -- path/to/file").
				if (
					/(?:^|\s)git\s+checkout\b/i.test(trimmed) &&
					!/(?:^|\s)git\s+checkout\b[\s\S]*\s--\s/i.test(trimmed)
				) {
					return `🚫 BLOCKED: Do NOT switch git branches in SWE-bench mode.

The task may require running tests, but they might not exist yet or may be incomplete.
Focus on understanding the problem and implementing the fix based on the problem description.

If you intended to restore a file, use "git checkout -- <path>".

Attempted command: ${trimmed}`
				}
			}
		}

		// Note: Project exploration requirements removed
		// Reason: In SWE-bench, tests may not exist or be incomplete
		// Agent should focus on understanding the problem and implementing fixes
		// rather than being forced to find potentially non-existent tests

		// 最后检查状态机规则
		const blockReason = this.stateMachine.getBlockReason(toolName)

		if (blockReason) {
			this.config.onToolBlocked?.(toolName, blockReason)

			if (this.config.strictMode) {
				return blockReason
			}

			// In non-strict mode, just log a warning
			console.warn(`[SWEBench] Tool "${toolName}" would be blocked: ${blockReason}`)
		}

		return null
	}

	/**
	 * Record that a tool was executed and update state
	 */
	recordToolExecution(toolName: ToolName, params?: Record<string, unknown>, output?: string): string | null {
		// 更新最后工具执行时间
		this.lastToolExecutionTime = Date.now()

		let guidanceToReturn: string | null = null

		// If the agent uses MCP sequential-thinking, treat it as a reset signal for apply_diff thrash/jinnang.
		// This should NOT affect the state machine's one-time guidance flags.
		const toolNameString = String(toolName).toLowerCase()
		if (
			toolNameString === "mcp--sequential-thinking--sequentialthinking" ||
			toolNameString.includes("sequential-thinking") ||
			toolNameString.includes("sequentialthinking")
		) {
			this.resetApplyDiffStreak()
		}

		if (toolName === "apply_diff") {
			this.consecutiveApplyDiffCount++

			// 第二个锦囊：在第二次 apply_diff 后给一次轻提示（不阻断）
			if (this.consecutiveApplyDiffCount === 2 && !this.secondJinnangShown) {
				this.secondJinnangShown = true
				guidanceToReturn = this.getSecondJinnangGuidance()
				this.config.onToolGuidance?.(toolName, guidanceToReturn)
			}
		}

		// Provide guidance for write_to_file usage in MODIFY/VERIFY phases
		if (toolName === "write_to_file") {
			const currentPhase = this.stateMachine.getState().phase
			const filePath = params?.path as string | undefined

			// In MODIFY/VERIFY phases, provide guidance if used for code/test editing
			if ((currentPhase === "MODIFY" || currentPhase === "VERIFY") && filePath) {
				const isCodeFile = /\.(py|js|ts|java|cpp|c|h|hpp|go|rs|rb|php|swift|kt|scala|r|m|mm)$/i.test(filePath)
				const isTestFile = /test|spec|__tests__/i.test(filePath)

				if (isCodeFile || isTestFile) {
					const guidance = `💡 **Tool Usage Recommendation:**

You're using \`write_to_file\` to modify a ${isTestFile ? "test" : "code"} file.

**Recommendation:**
• Prefer \`apply_diff\` for modifying code/test files (more accurate and preserves context)
• \`write_to_file\` is better suited for creating new utility scripts/tools (e.g., run_p2p_tests.py)
• \`apply_diff\` provides better diff tracking and is the preferred method for code modifications

**Note:** This is allowed, but \`apply_diff\` is recommended for better accuracy when editing existing files.`

					// Provide guidance via callback (non-blocking, appended to tool result)
					this.config.onToolGuidance?.(toolName, guidance)
				}
			}
		}

		// 判断操作是否成功
		const success = this.isOperationSuccessful(toolName, output)

		// 记录到执行历史
		this.executionHistory.push({
			toolName,
			params: params || {},
			output,
			timestamp: this.lastToolExecutionTime,
			success,
		})

		// 记录输出历史（用于输出循环检测）
		if (output) {
			this.outputHistory.push({
				content: output,
				timestamp: this.lastToolExecutionTime,
				toolName,
				params: params || {},
			})

			// 限制输出历史大小
			if (this.outputHistory.length > this.MAX_OUTPUT_HISTORY_SIZE) {
				this.outputHistory = this.outputHistory.slice(-this.MAX_OUTPUT_HISTORY_SIZE)
			}
		}

		// 限制执行历史大小
		if (this.executionHistory.length > this.MAX_HISTORY_SIZE) {
			this.executionHistory = this.executionHistory.slice(-this.MAX_HISTORY_SIZE)
		}

		// 原有的状态机更新逻辑
		const oldState = this.stateMachine.getState()
		this.stateMachine.recordToolUse(toolName, params, output)
		const newState = this.stateMachine.getState()

		// On every 50th tool call, we increase the reasoning budget.
		// Attach an extra "don't give up" prompt to the tool result at that boundary.
		if ((oldState.toolCallsCount ?? 0) !== (newState.toolCallsCount ?? 0) && (newState.toolCallsCount ?? 0) > 0) {
			const calls = newState.toolCallsCount ?? 0
			if (calls % 50 === 0) {
				const budgetNote = `

🧠 Reasoning budget increased (tool calls: ${calls}).

If you get stuck: call the sequential-thinking MCP, analyze the root cause and the current blocker, decide the next minimal verifiable action, and do not give up on solving the problem.`
				guidanceToReturn = guidanceToReturn ? `${guidanceToReturn}${budgetNote}` : budgetNote.trimStart()
			}
		}

		if (oldState.phase !== newState.phase) {
			this.config.onStateChange?.(oldState, newState)
			console.log(`[SWEBench] Phase transition: ${oldState.phase} -> ${newState.phase}`)

			const phaseGuidance = this.getPhaseTransitionSequentialThinkingGuidance(newState.phase)
			if (phaseGuidance) {
				this.config.onToolGuidance?.(toolName, phaseGuidance)
			}
		}

		// 提供智能提醒并记录到历史中
		if (!success) {
			const guidance = this.provideFailureGuidance(toolName, params, output)
			if (guidance) {
				// 将指导信息添加到最新的执行记录中，这样可以在后续的循环检测中使用
				const lastRecord = this.executionHistory[this.executionHistory.length - 1]
				if (lastRecord) {
					lastRecord.guidance = guidance
				}
			}
		}

		// 返回第二个锦囊的 guidance（如果有）
		return guidanceToReturn
	}

	/**
	 * 为失败的操作提供指导（返回指导信息而不是仅仅 console.log）
	 */
	private provideFailureGuidance(
		toolName: ToolName,
		params?: Record<string, unknown>,
		output?: string,
	): string | null {
		if (toolName === "search_files" && output?.includes("Found 0 results")) {
			const searchTerm = params?.regex || params?.query
			return `🔍 Search for "${searchTerm}" found no results. Try better search strategies:

🎯 Test Discovery Tips:
1. Search for core parts of test method names (remove test_ prefix)
   - Example: "clash_parent_link" instead of "test_clash_parent_link"

2. Search for test class names:
   - Look for classes ending in "Tests" or "Test"
   - Search for domain-specific test class names

3. Search for functional keywords:
   - Use terms from the problem description
   - Search for related functionality or feature names

4. Explore test directory structure:
   - Use list_files on tests/ to see available test modules
   - Check subdirectories for organized test categories
   - Look for test files matching the problem domain

💡 Remember: Tests may not exist yet or be incomplete. Focus on understanding the problem from the description and error messages.`
		}

		if (toolName === "execute_command" && this.isIndividualTestCommand(params?.command as string)) {
			return `🎯 TESTING STRATEGY IMPROVEMENT NEEDED:

Instead of running individual tests one by one repeatedly, consider:

✅ PREFERRED: Run comprehensive test suites
   • python -m pytest path/to/test_module.py -v
   • python -m pytest path/to/tests/ -k "keyword" -v
   • ./runtests.py --pattern="*test*" --verbosity=2

✅ BATCH VALIDATION: Run multiple related tests together
   • python -m pytest test_file1.py test_file2.py -v
   • python -m pytest -k "test_feature" -v

❌ AVOID: Repeatedly running the same individual test
   • This is time-consuming and triggers false positive loop detection
   • Single test runs provide limited validation coverage

💡 Comprehensive test runs are more efficient and provide better validation of your changes.`
		}

		if (toolName === "execute_command" && output?.includes("AttributeError")) {
			return `🎯 Test execution encountered AttributeError. This usually means:

1. Check if you're using the correct test runner:
   - Read README.md or docs/ for testing instructions
   - Look for project-specific test runner scripts

2. Verify test path format:
   - Check the project's test naming conventions
   - Try running broader test scopes (module or class level)

3. Explore test structure:
   - Use list_files to understand test organization
   - Read test runner scripts to understand usage patterns

4. Check working directory:
   - Some projects require running from specific directories
   - Check documentation for correct execution location

💡 Systematic exploration of project structure will reveal the correct test execution method.`
		}

		if (toolName === "execute_command" && output?.includes("No module named")) {
			const missingModule = output.match(/No module named '([^']+)'/)?.[1]
			return `🚫 Missing module "${missingModule}". For SWE-bench tasks:

🎯 DO NOT install dependencies. Instead:
1. Use the project's native test runner (check README.md)
2. Look for project-specific test scripts (runtests.py, test.py, etc.)
3. Check if you're in the correct directory
4. Explore project documentation for test setup

💡 SWE-bench environments are pre-configured. Missing modules may indicate incomplete test setup. Focus on implementing the fix based on the problem description rather than forcing test execution.`
		}

		return null
	}

	/**
	 * Get the current state machine
	 */
	getStateMachine(): SWEBenchStateMachine {
		return this.stateMachine
	}

	/**
	 * Apply repository-aware path mapping to tool parameters
	 */
	applyRepositoryPathMapping(toolName: ToolName, params: Record<string, unknown>): Record<string, unknown> {
		return this.applyPathMappingToParams(toolName, params) || params
	}

	/**
	 * Validate repository constraints for tool usage
	 */
	validateRepositoryConstraints(toolName: ToolName, params: Record<string, unknown>): ValidationResult {
		// Get repository configuration
		const repositoryConfig = this.stateMachine.getRepositoryConfig()

		// Repository-specific validation logic
		if (repositoryConfig.projectType === "django" && toolName === "execute_command") {
			const command = params.command as string
			if (command && command.includes("runtests.py")) {
				// Django-specific validation for runtests.py usage
				if (!command.includes("--settings") && !command.includes("--verbosity")) {
					return {
						allowed: true,
						suggestion:
							"Consider adding --settings=test_sqlite and --verbosity=2 for better Django test output",
						severity: "info",
					}
				}
			}
		}

		return { allowed: true, severity: "info" }
	}

	/**
	 * Detect loops and provide recovery guidance
	 */
	detectLoops(): LoopDetectionResult {
		// Check for output loops
		if (this.detectOutputLoop()) {
			return {
				detected: true,
				type: "output",
				severity: "high",
				message: "Repeating identical output content detected",
			}
		}

		// Check for stagnation
		if (this.detectStagnation()) {
			return {
				detected: true,
				type: "stagnation",
				severity: "medium",
				message: "No tool execution for extended period",
			}
		}

		// Check for failure loops
		const recentFailures = this.executionHistory.slice(-5).filter((r) => !r.success).length
		if (recentFailures >= 3) {
			return {
				detected: true,
				type: "failure",
				severity: "high",
				message: "Multiple consecutive failures detected",
			}
		}

		return { detected: false }
	}

	/**
	 * Generate recovery guidance for detected loops
	 */
	generateRecoveryGuidance(loopType: LoopType): string {
		const currentPhase = this.stateMachine.getPhase()

		switch (loopType) {
			case "output":
				return `🔄 OUTPUT LOOP RECOVERY:
• Stop repeating the same actions
• Move to next phase: ${this.getNextPhaseGuidance(currentPhase)}
• Run MCP sequential-thinking to restate the contradiction and pick a new action
• Focus on making progress rather than re-reading same content`

			case "stagnation":
				return `⏰ STAGNATION RECOVERY:
• Take immediate action in current phase: ${currentPhase}
• ${this.getPhaseSpecificGuidance(currentPhase)}
• Call MCP sequential-thinking to generate 1-2 concrete next steps, then execute one immediately
• Avoid timeout by making concrete progress`

			case "failure":
				return `🚨 FAILURE LOOP RECOVERY:
• Change your approach completely
• Run MCP sequential-thinking to re-rank hypotheses and list quick falsification checks
• Try different commands or strategies
• Review phase guidance for alternative methods
• Consider that your assumptions may be incorrect`

			default:
				return "Unknown loop type detected. Please try a different approach."
		}
	}

	/**
	 * Get guidance for next phase transition
	 */
	private getNextPhaseGuidance(currentPhase: string): string {
		switch (currentPhase) {
			case "ANALYZE":
				return "Run tests to understand the problem, then move to MODIFY"
			case "MODIFY":
				return "Apply code changes, then move to VERIFY"
			case "VERIFY":
				return "Verify tests pass, then call attempt_completion to submit"
			default:
				return "Follow the phase guidance"
		}
	}

	/**
	 * Get phase-specific guidance for recovery
	 */
	private getPhaseSpecificGuidance(phase: string): string {
		switch (phase) {
			case "ANALYZE":
				return "Read project files, explore test structure, run FAIL_TO_PASS tests, re-anchor hypotheses with sequential-thinking"
			case "MODIFY":
				return "Apply code changes using apply_diff to fix the failing tests, summarize the patch plan via sequential-thinking first"
			case "VERIFY":
				return "Re-run tests to verify your changes work correctly, and if regressions appear, rerun sequential-thinking before patching again"
			default:
				return "Follow the current phase requirements"
		}
	}

	private getPhaseTransitionSequentialThinkingGuidance(newPhase: SWEBenchPhase): string | null {
		switch (newPhase) {
			case "MODIFY":
				return `🧠 Entering MODIFY phase

Before editing code, call MCP sequential-thinking to:
1. Rank the current root-cause hypotheses
2. Pick the smallest viable change
3. Map the verification you will run immediately after the patch

Suggested totalThoughts: 5 (default) / 8+ if multiple modules are involved.`
			case "VERIFY":
				return `🧠 Entering VERIFY phase

Use MCP sequential-thinking to design your verification plan:
1. List FAIL_TO_PASS commands you must rerun
2. Add PASS_TO_PASS or regression checks needed for confidence
3. Decide how you'll react if a test still fails (next hypothesis, next command)

TotalThoughts guideline: 3-5 for straightforward fixes, 8+ if failures persist.`
			default:
				return null
		}
	}

	/**
	 * Get current phase
	 */
	getCurrentPhase(): string {
		return this.stateMachine.getPhase()
	}

	/**
	 * Get status summary for debugging
	 */
	getStatusSummary(): string {
		return this.stateMachine.getStatusSummary()
	}

	/**
	 * Get current reasoning configuration for the current phase
	 */
	getCurrentReasoningConfig(): { reasoningEffort?: string; reasoningBudget?: number } | undefined {
		return this.stateMachine.getCurrentReasoningConfig()
	}

	/**
	 * Get the onLog callback if available
	 */
	getOnLogCallback(): ((message: string) => void) | undefined {
		return this.config.onLog
	}

	/**
	 * Check if tests have been run
	 */
	hasRunTests(): boolean {
		return this.stateMachine.getState().hasRunTests
	}

	/**
	 * Reset the interceptor state (for new task)
	 */
	reset(): void {
		this.stateMachine = new SWEBenchStateMachine()
		this.executionHistory = []
		this.outputHistory = []
		this.loopDetectionCount = 0
		this.lastToolExecutionTime = Date.now()
		this.resetApplyDiffStreak()
	}

	/**
	 * Serialize state for persistence
	 */
	serialize(): string {
		return this.stateMachine.serialize()
	}

	/**
	 * Set instance ID for instance-specific guidance
	 */
	setInstanceId(instanceId: string): void {
		this.stateMachine.setInstanceId(instanceId)
		this.resetApplyDiffStreak()
	}

	/**
	 * Restore from serialized state
	 */
	restore(serialized: string, instanceId?: string): void {
		this.stateMachine = SWEBenchStateMachine.deserialize(serialized, instanceId)
		this.resetApplyDiffStreak()
	}

	private getApplyDiffJinnangGuidance(): string {
		const instanceId = this.stateMachine.getState().instanceId
		const repoGuidance = instanceId ? this.getRepositorySpecificGuidance(instanceId) : ""

		return `🧰 Jinnang Triggered: apply_diff thrashing detected.

This apply_diff call has been BLOCKED to prevent unproductive patch churn.

MANDATORY: Use MCP sequential-thinking to re-anchor on the core of the problem.

Call sequential-thinking for multiple steps (totalThoughts >= 3). In your thoughts, explicitly cover:
1) Core contradiction / bottleneck
   - What is the central tension? (e.g. minimal change vs uncertain root cause)
2) Top hypotheses (ranked)
   - Hypothesis A/B/C with supporting evidence and strongest counter-evidence
3) Uncertainty map
   - What facts are missing? What could you be wrong about? (imports/caches/state, test runner mismatch, path mapping, env constraints)
4) Fast falsification plan
   - 1-3 concrete checks using execute_command/read_file/search_files to disprove hypotheses
5) Minimal patch plan
   - Exactly which file(s)/function(s) and what change (single focused change)
6) Verification plan
   - Exact FAIL_TO_PASS and PASS_TO_PASS commands

After the sequential-thinking output, take ONE concrete action (execute_command/read_file/search_files). Only then submit the next apply_diff.

${repoGuidance ? `Repository-specific guidance:\n\n${repoGuidance}\n\n` : ""}`
	}

	private getSecondJinnangGuidance(): string {
		return `🧰 Quick Nudge: Use Sequential Thinking (MCP)

Before the next patch, call MCP sequential-thinking once to crystallize:
- the most likely root cause hypothesis
- the single next verification step
- the smallest safe change

Then immediately run that verification step (execute_command/read_file/search_files) before applying another diff.`
	}
}

export function getActiveSWEBenchInterceptor(): SWEBenchToolInterceptor | null {
	return activeInterceptor
}

/**
 * Activate SWE-bench mode with a new interceptor
 */
export function activateSWEBenchMode(
	config?: Partial<SWEBenchInterceptorConfig>,
	instanceId?: string,
): SWEBenchToolInterceptor {
	activeInterceptor = new SWEBenchToolInterceptor(config, instanceId)

	if (instanceId) {
		console.log(`[SWEBench] Mode activated with state machine enforcement for instance: ${instanceId}`)
	} else {
		console.log("[SWEBench] Mode activated with state machine enforcement")
	}
	return activeInterceptor
}

/**
 * Deactivate SWE-bench mode
 */
export function deactivateSWEBenchMode(): void {
	if (activeInterceptor) {
		console.log("[SWEBench] Mode deactivated")
		activeInterceptor = null
	}
}

/**
 * Check if SWE-bench mode is active
 */
export function isSWEBenchModeActive(): boolean {
	return activeInterceptor !== null
}

function normalizeToolNameForSWEBench(toolName: ToolName): ToolName {
	const name = String(toolName)

	if (name === "readFile") {
		return "read_file" as ToolName
	}
	if (name === "listFilesTopLevel") {
		return "list_files" as ToolName
	}
	if (name === "listFilesRecursive") {
		return "list_files" as ToolName
	}
	if (name === "searchFiles") {
		return "search_files" as ToolName
	}
	if (name === "executeCommand") {
		return "execute_command" as ToolName
	}
	if (name === "applyDiff") {
		return "apply_diff" as ToolName
	}

	return toolName
}

/**
 * Validate tool use against SWE-bench state machine (if active)
 * This is the main integration point with validateToolUse.ts
 */
export function validateSWEBenchToolUse(toolName: ToolName, params?: Record<string, unknown>): string | null {
	if (!activeInterceptor) {
		return null // SWE-bench mode not active, allow all tools
	}

	return activeInterceptor.validateToolUse(normalizeToolNameForSWEBench(toolName), params)
}

/**
 * Apply SWE-bench path mapping to tool parameters (if active)
 * Maps /testbed/* paths to /workspace/repo/* paths
 */
export function applySWEBenchPathMapping(
	toolName: ToolName,
	params?: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (!activeInterceptor) {
		return params // SWE-bench mode not active, return params unchanged
	}

	return activeInterceptor.applyPathMappingToParams(normalizeToolNameForSWEBench(toolName), params)
}

/**
 * Record tool execution in SWE-bench state machine (if active)
 * Should be called after successful tool execution
 */
export function recordSWEBenchToolExecution(
	toolName: ToolName,
	params?: Record<string, unknown>,
	output?: string,
): string | null {
	if (activeInterceptor) {
		const normalizedToolName = normalizeToolNameForSWEBench(toolName)
		console.log(`[SWEBench-Debug] Recording tool execution: ${normalizedToolName}`)
		const oldState = activeInterceptor.getStateMachine().getState()

		const guidance = activeInterceptor.recordToolExecution(normalizedToolName, params, output)
		const newState = activeInterceptor.getStateMachine().getState()

		// Log state machine information for progress tracking
		logSWEBenchStateInfo(normalizedToolName, params, oldState, newState)

		// Check for file modifications using git diff (for any tool that might modify files)
		if (shouldCheckForFileModifications(normalizedToolName)) {
			checkAndLogFileModifications()
		}

		// Return guidance if available (e.g., second jinnang)
		return guidance || null
	} else {
		console.log(`[SWEBench-Debug] No active interceptor for tool: ${toolName}`)
		return null
	}
}

/**
 * Log SWE-bench state machine information for progress tracking
 * Uses the interceptor's log callback if available, otherwise falls back to console.log
 */
function logSWEBenchStateInfo(
	toolName: ToolName,
	params: Record<string, unknown> | undefined,
	oldState: SWEBenchState,
	newState: SWEBenchState,
): void {
	const logMessage = (message: string) => {
		const onLogCallback = activeInterceptor?.getOnLogCallback()
		if (onLogCallback) {
			onLogCallback(message)
		} else {
			console.log(message)
		}
	}

	// Always log current state after tool execution
	logMessage(
		`[SWEBench-State] Phase: ${newState.phase} | ` +
			`Tests: ${newState.testsRunCount} | ` +
			`Mods: ${newState.modificationCount} | ` +
			`Passed: ${newState.testsPassedAfterModify ? "YES" : "NO"} | ` +
			`Tool: ${toolName}`,
	)

	// Log phase transitions
	if (oldState.phase !== newState.phase) {
		logMessage(
			`[SWEBench-Transition] ${oldState.phase} -> ${newState.phase} | ` +
				`Reason: ${getTransitionReason(toolName, oldState, newState)}`,
		)
	}

	// Log project exploration progress
	if (newState.phase === "ANALYZE" && !newState.projectExplored) {
		logMessage(
			`[SWEBench-Exploration] README: ${newState.readmeRead ? "✓" : "✗"} | ` +
				`Tests: ${newState.testStructureExplored ? "✓" : "✗"} | ` +
				`Targets: ${newState.targetTestsLocated ? "✓" : "✗"}`,
		)
	}

	// Note: File modification logging is handled in recordSWEBenchToolExecution
}

/**
 * Get human-readable reason for phase transition
 */
function getTransitionReason(toolName: ToolName, oldState: SWEBenchState, newState: SWEBenchState): string {
	if (oldState.phase === "ANALYZE" && newState.phase === "MODIFY") {
		return "Valid test execution detected"
	}
	if (oldState.phase === "MODIFY" && newState.phase === "VERIFY") {
		return `Code modified (${newState.modificationCount} changes)`
	}
	// VERIFY phase no longer transitions to COMPLETE - stay in VERIFY and allow attempt_completion
	if (oldState.phase === "VERIFY" && newState.phase === "MODIFY") {
		return "Tests still failing, returning to modify"
	}
	return `Tool: ${toolName}`
}

/**
 * Get current reasoning configuration for SWE-bench phase (if active)
 * Returns the reasoning configuration that should be used for the current phase
 */
export function getSWEBenchReasoningConfig(): { reasoningEffort?: string; reasoningBudget?: number } | undefined {
	if (!activeInterceptor) {
		return undefined
	}
	return activeInterceptor.getCurrentReasoningConfig()
}

/**
 * Check if we should check for file modifications after this tool execution
 */
function shouldCheckForFileModifications(toolName: ToolName): boolean {
	if (!activeInterceptor) {
		return false
	}

	const currentPhase: SWEBenchPhase = activeInterceptor.getStateMachine().getState().phase

	// In ANALYZE phase, only explicit file modification tools should trigger checks
	if (currentPhase === "ANALYZE") {
		const explicitFileModifyingTools = ["apply_diff", "write_to_file", "search_and_replace", "search_replace"]
		return explicitFileModifyingTools.includes(toolName)
	}

	// After MODIFY phase (MODIFY, VERIFY), any tool could modify files
	// This includes execute_command with sed/awk/vim, read_file with editors, etc.
	if (currentPhase === "MODIFY" || currentPhase === "VERIFY") {
		// Check after most tools, excluding only pure read operations
		const pureReadOnlyTools = ["list_files"] // Very conservative list
		return !pureReadOnlyTools.includes(toolName)
	}

	return false
}

/**
 * Use git diff to check for actual file modifications and log them
 */
function checkAndLogFileModifications(): void {
	try {
		// Use git diff to get list of modified files
		const { execSync } = require("child_process")

		// Get modified files (both staged and unstaged)
		const gitDiffOutput = execSync("git diff --name-only HEAD", {
			encoding: "utf8",
			timeout: 5000, // 5 second timeout
			cwd: process.cwd(),
		}).trim()

		if (gitDiffOutput) {
			const modifiedFiles = gitDiffOutput.split("\n").filter((file: string) => file.trim())
			if (modifiedFiles.length > 0) {
				const logMessage = (message: string) => {
					const onLogCallback = activeInterceptor?.getOnLogCallback()
					if (onLogCallback) {
						onLogCallback(message)
					} else {
						console.log(message)
					}
				}

				logMessage(`[SWEBench-GitDiff] Modified files: ${modifiedFiles.join(", ")}`)

				// Also get a summary of changes
				try {
					const diffStat = execSync("git diff --stat HEAD", {
						encoding: "utf8",
						timeout: 5000,
						cwd: process.cwd(),
					}).trim()

					if (diffStat) {
						// Extract summary line (last line usually contains the summary)
						const lines = diffStat.split("\n")
						const summaryLine = lines[lines.length - 1]
						if (summaryLine && /\d+.*file.*changed/.test(summaryLine)) {
							logMessage(`[SWEBench-GitDiff] Changes: ${summaryLine}`)
						}
					}
				} catch (error) {
					// Ignore diff stat errors, just log the files
				}
			}
		}
	} catch (error) {
		// Silently ignore git errors (might not be in a git repo, or git not available)
		// This is expected in some test environments
	}
}
