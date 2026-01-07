/**
 * SWE-bench State Machine
 *
 * Enforces a strict workflow for SWE-bench tasks:
 * 1. ANALYZE: Read code, list files, run tests to understand the problem
 * 2. MODIFY: Apply code changes (only after tests have been run)
 * 3. VERIFY: Re-run tests to verify the fix and submit the solution
 *
 * The state machine blocks `apply_diff` until tests have been run at least once,
 * ensuring the agent understands the expected behavior before making changes.
 */

import type { ToolName } from "@roo-code/types"
import { getRecommendedTestCommand } from "./instance-prompts"
import { getRepositoryConfig, checkUnderstandingRequirement, type RepositoryConfig } from "./repository-config"
import { generatePhaseGuidance } from "./prompt-generator"
import { createTestAnalyzer, type TestCommandAnalysis, type TestClassification } from "./test-analyzer"
import {
	createFlexibleExplorationStrategy,
	createProgressiveGuidanceEscalator,
	type FlexibleExplorationStrategy,
	type ProgressiveGuidanceEscalator,
} from "./flexible-exploration"

export type SWEBenchPhase = "ANALYZE" | "MODIFY" | "VERIFY"

const SWEBENCH_REASONING_BUDGET_INITIAL_SCALE = 0.5
const SWEBENCH_REASONING_BUDGET_STEP_SCALE = 0.5
const SWEBENCH_REASONING_BUDGET_STEP_TOOL_CALLS = 50

const SWEBENCH_VERIFY_EXECUTE_COMMANDS_REQUIRED = 6

const SWEBENCH_REASONING_BUDGET_MAX: Record<SWEBenchPhase, number> = {
	ANALYZE: 16384,
	MODIFY: 8192,
	VERIFY: 16384,
}

function computeDynamicReasoningBudget(maxBudget: number, toolCallsCount: number): number {
	const steps = Math.floor(toolCallsCount / SWEBENCH_REASONING_BUDGET_STEP_TOOL_CALLS)
	const scale = Math.min(1, SWEBENCH_REASONING_BUDGET_INITIAL_SCALE + steps * SWEBENCH_REASONING_BUDGET_STEP_SCALE)
	return Math.floor(maxBudget * scale)
}

export interface SWEBenchState {
	// Core workflow state
	readonly phase: SWEBenchPhase
	readonly instanceId?: string
	readonly repositoryType?: string

	// Execution tracking
	readonly toolCallsCount: number
	readonly testsRunCount: number
	readonly modificationCount: number
	readonly testsPassedAfterModify: boolean
	readonly hasRunTests: boolean
	readonly attemptCompletionCount: number

	// First modification guidance tracking
	readonly firstModificationGuidanceShown: boolean

	// Understanding tracking (flexible requirements)
	readonly readCallsCount: number
	readonly testCallsCount: number
	readonly understandingLevel?: "insufficient" | "basic" | "adequate" | "comprehensive"
	readonly modificationReadiness: boolean

	// Repository-specific tracking
	readonly explorationState: ExplorationState
	readonly testExecutionHistory: TestExecution[]
	readonly modificationHistory: FileModification[]

	// Legacy fields (for backward compatibility)
	lastTestOutput: string | null
	modifiedFiles: string[]
	currentReasoningConfig?: SWEBenchReasoningConfig
	projectExplored: boolean
	readmeRead: boolean
	testStructureExplored: boolean
	targetTestsLocated: boolean
	lastTestCommand?: string
}

export interface ExplorationState {
	readonly readmeRead: boolean
	readonly testStructureExplored: boolean
	readonly targetTestsLocated: boolean
	readonly configurationUnderstood: boolean
	readonly repositoryMapped: boolean
	readonly explorationScore: number // 0-100 based on various factors
	readonly recommendedActions: string[]
}

export interface TestExecution {
	readonly command: string
	readonly output: string
	readonly timestamp: number
	readonly success: boolean
	readonly testType: "f2p" | "p2p" | "discovery" | "validation" | "unknown"
	readonly detectedTests: string[]
	readonly repositoryMatch: boolean
	readonly confidence: number
	readonly analysisSource: "instance-prompt" | "pattern-match" | "heuristic"
}

export interface FileModification {
	readonly filePath: string
	readonly timestamp: number
	readonly toolUsed: ToolName
	readonly changeType: "create" | "modify" | "delete"
}

export interface ValidationResult {
	readonly allowed: boolean
	readonly reason?: string
	readonly suggestion?: string
	readonly severity: "error" | "warning" | "info"
}

export interface UnderstandingCheck {
	readonly sufficient: boolean
	readonly readCallsCount: number
	readonly testCallsCount: number
	readonly requiredCalls: number
	readonly recommendation: string
}

export interface SWEBenchReasoningConfig {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "disable"
	reasoningBudget?: number
}

export interface PhaseConfig {
	allowedTools: readonly ToolName[]
	description: string
	reasoningConfig?: SWEBenchReasoningConfig
	transitionCondition?: (state: SWEBenchState, toolName: ToolName, toolOutput?: string) => SWEBenchPhase | null
}

// SWE-bench uses a minimal tool set:
// - read_file, list_files, search_files: for code exploration
// - execute_command: for running tests
// - apply_diff: preferred for code modifications
// - write_to_file: allowed in MODIFY/VERIFY for small helper scripts (not preferred for editing existing code)
// - attempt_completion: for submitting the solution

// The only code modification tool allowed in SWE-bench mode
const CODE_MODIFICATION_TOOLS: readonly ToolName[] = ["apply_diff"] as const

// Tools allowed in each phase
// Note: write_to_file is allowed in MODIFY/VERIFY phases for creating scripts/tools, but not for code/test editing
const ANALYZE_TOOLS: readonly ToolName[] = [
	"read_file",
	"list_files",
	"search_files",
	"execute_command",
	"use_mcp_tool",
	"access_mcp_resource",
] as const

const MODIFY_TOOLS: readonly ToolName[] = [...ANALYZE_TOOLS, ...CODE_MODIFICATION_TOOLS, "write_to_file"] as const

const VERIFY_TOOLS: readonly ToolName[] = [...MODIFY_TOOLS, "attempt_completion"] as const

/**
 * Check if a tool is a code modification tool
 */
export function isCodeModificationTool(toolName: ToolName): boolean {
	return CODE_MODIFICATION_TOOLS.includes(toolName)
}

/**
 * Check if a file path appears to be a test file
 * Detects common test file patterns across different languages and frameworks
 */
export function isTestFile(filePath: string): boolean {
	const normalizedPath = filePath.toLowerCase()

	// Common test file patterns
	const testPatterns = [
		// Python
		/test_.*\.py$/i,
		/.*_test\.py$/i,
		/tests?\/.*\.py$/i,
		/.*\/tests?\/.*\.py$/i,

		// JavaScript/TypeScript
		/.*\.test\.(js|ts|jsx|tsx)$/i,
		/.*\.spec\.(js|ts|jsx|tsx)$/i,
		/tests?\/.*\.(js|ts|jsx|tsx)$/i,
		/__tests__\/.*\.(js|ts|jsx|tsx)$/i,

		// Java (case sensitive for Java naming conventions)
		/.*test\.java$/i,
		/.*tests\.java$/i,
		/test\/.*\.java$/i,

		// Go
		/.*_test\.go$/i,

		// C/C++
		/test_.*\.(c|cpp|cc|cxx)$/i,
		/.*_test\.(c|cpp|cc|cxx)$/i,

		// Ruby
		/.*_test\.rb$/i,
		/test_.*\.rb$/i,
		/spec\/.*\.rb$/i,

		// General patterns (directory-based)
		/\/tests?\//i,
		/\/test\//i,
		/\/__tests__\//i,
		/\/spec\//i,
		/\/specs\//i,

		// Path starts with test directories (no leading slash)
		/^tests?\//i,
		/^test\//i,
		/^__tests__\//i,
		/^spec\//i,
		/^specs\//i,
	]

	return testPatterns.some((pattern) => pattern.test(normalizedPath))
}

export const PHASE_CONFIGS: Record<SWEBenchPhase, PhaseConfig> = {
	ANALYZE: {
		allowedTools: ANALYZE_TOOLS,
		description: "Understand the problem and explore the codebase.",
		reasoningConfig: {
			reasoningEffort: "high",
			reasoningBudget: SWEBENCH_REASONING_BUDGET_MAX.ANALYZE,
		},
	},
	MODIFY: {
		allowedTools: MODIFY_TOOLS,
		description: "Implement the fix.",
		reasoningConfig: {
			reasoningEffort: "medium",
			reasoningBudget: SWEBENCH_REASONING_BUDGET_MAX.MODIFY,
		},
	},
	VERIFY: {
		allowedTools: VERIFY_TOOLS,
		description: "Verify the fix by testing and submit the solution.",
		reasoningConfig: {
			reasoningEffort: "low",
			reasoningBudget: SWEBENCH_REASONING_BUDGET_MAX.VERIFY,
		},
	},
}

// Patterns to detect test execution commands
// These patterns are designed to match actual test execution
// For chained commands (&&, ;), we split and check each part
const TEST_COMMAND_PATTERNS = [
	/python\s+-m\s+pytest/i,
	/(?:^|[;&|]\s*)pytest\b/i, // pytest at start or after command separator
	/python\s+-m\s+unittest/i,
	/(?:^|\s)(?:python\s+)?(?:\.\/)?(?:tests\/)?runtests\.py\b/i,
	/(?:^|[;&|]\s*)tox\b/i,
	/(?:^|[;&|]\s*)nox\b/i,
	/manage\.py\s+test/i,
	/cargo\s+test/i,
	/npm\s+test/i,
	/yarn\s+test/i,
	/go\s+test/i,
]

/**
 * Check if a command string contains a test execution
 * Handles chained commands like "pip install -e . && pytest"
 */
export function isTestCommand(command: string): boolean {
	// Split by common command separators and check each part
	const parts = command.split(/\s*(?:&&|;|\|\|)\s*/)

	for (const part of parts) {
		const trimmed = part.trim()
		// Skip empty parts and pure install commands
		if (!trimmed || /^(?:pip|conda|npm|yarn)\s+(?:install|add)/i.test(trimmed)) {
			continue
		}

		// Treat pure help/version invocations as non-test exploration commands.
		// This prevents blocking legitimate discovery steps in ANALYZE phase.
		if (
			/(?:^|\s)(?:python\s+)?(?:\.\/)?(?:tests\/)?runtests\.py\b/i.test(trimmed) &&
			/(?:^|\s)(?:-h|--help|--version)\b/i.test(trimmed)
		) {
			continue
		}
		// Check if this part is a test command
		if (TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(trimmed))) {
			return true
		}
	}

	return false
}

export function createInitialState(instanceId?: string): SWEBenchState {
	const explorationState: ExplorationState = {
		readmeRead: false,
		testStructureExplored: false,
		targetTestsLocated: false,
		configurationUnderstood: false,
		repositoryMapped: false,
		explorationScore: 0,
		recommendedActions: [],
	}

	return {
		// Core workflow state
		phase: "ANALYZE",
		instanceId,
		repositoryType: undefined,

		// Execution tracking
		toolCallsCount: 0,
		testsRunCount: 0,
		modificationCount: 0,
		testsPassedAfterModify: false,
		hasRunTests: false,
		attemptCompletionCount: 0,

		// First modification guidance tracking
		firstModificationGuidanceShown: false,

		// Understanding tracking
		readCallsCount: 0,
		testCallsCount: 0,
		understandingLevel: "insufficient",
		modificationReadiness: false,

		// Repository-specific tracking
		explorationState,
		testExecutionHistory: [],
		modificationHistory: [],

		// Legacy fields (for backward compatibility)
		lastTestOutput: null,
		modifiedFiles: [],
		currentReasoningConfig: {
			...PHASE_CONFIGS.ANALYZE.reasoningConfig,
			reasoningBudget: computeDynamicReasoningBudget(SWEBENCH_REASONING_BUDGET_MAX.ANALYZE, 0),
		},
		projectExplored: false,
		readmeRead: false,
		testStructureExplored: false,
		targetTestsLocated: false,
		lastTestCommand: undefined,
	}
}

export class SWEBenchStateMachine {
	private state: SWEBenchState
	private repositoryConfig: RepositoryConfig
	private testAnalyzer = createTestAnalyzer()
	private explorationStrategy: FlexibleExplorationStrategy = createFlexibleExplorationStrategy()
	private guidanceEscalator: ProgressiveGuidanceEscalator = createProgressiveGuidanceEscalator()

	constructor(initialState?: SWEBenchState, instanceId?: string) {
		const effectiveInstanceId = instanceId || initialState?.instanceId
		this.state = initialState ?? createInitialState(effectiveInstanceId)
		this.repositoryConfig = getRepositoryConfig(effectiveInstanceId || "")

		// Update state with repository information
		if (effectiveInstanceId && !this.state.instanceId) {
			this.state = {
				...this.state,
				instanceId: effectiveInstanceId,
				repositoryType: this.repositoryConfig.projectType,
			}
		}
	}

	getState(): SWEBenchState {
		return { ...this.state }
	}

	getPhase(): SWEBenchPhase {
		return this.state.phase
	}

	/**
	 * Mark that first modification guidance has been shown
	 * This allows the second apply_diff call to proceed
	 */
	markFirstModificationGuidanceShown(): void {
		this.state = { ...this.state, firstModificationGuidanceShown: true }
		console.log(`[SWEBench] First modification guidance shown, next apply_diff will proceed`)
	}

	/**
	 * Check if first modification guidance should be shown
	 * Returns true only on first apply_diff in ANALYZE phase without running tests
	 */
	shouldShowFirstModificationGuidance(): boolean {
		return (
			this.state.phase === "ANALYZE" &&
			this.state.modificationCount === 0 &&
			!this.state.hasRunTests &&
			!this.state.firstModificationGuidanceShown
		)
	}

	/**
	 * Check if a tool is allowed in the current phase
	 */
	isToolAllowed(toolName: ToolName): boolean {
		const config = PHASE_CONFIGS[this.state.phase]

		// attempt_completion is allowed in VERIFY phase
		if (toolName === "attempt_completion") {
			return this.state.phase === "VERIFY"
		}

		// Special case: allow code modification tools in ANALYZE phase after first attempt
		if (isCodeModificationTool(toolName) && this.state.phase === "ANALYZE") {
			// Allow if this is not the first modification attempt OR tests have been run
			return this.state.modificationCount > 0 || this.state.hasRunTests
		}

		return config.allowedTools.includes(toolName)
	}

	/**
	 * Get the reason why a tool is blocked (if it is)
	 */
	getBlockReason(toolName: ToolName): string | null {
		if (this.isToolAllowed(toolName)) {
			// Special validation for attempt_completion even when "allowed"
			if (toolName === "attempt_completion") {
				return this.validateAttemptCompletion()
			}
			return null
		}

		const phase = this.state.phase

		// Non-blocking guidance for first modification attempt in ANALYZE phase
		if (isCodeModificationTool(toolName) && this.state.phase === "ANALYZE") {
			// Check if this is the first modification attempt
			if (this.state.modificationCount === 0 && !this.state.hasRunTests) {
				// This is guidance, not a block - return null to allow the action
				// Guidance will be provided by the tool itself via pushToolResult
				return null
			}
		}

		// Block attempt_completion in non-VERIFY phases
		if (toolName === "attempt_completion" && phase !== "VERIFY") {
			return this.getAttemptCompletionBlockReason(phase)
		}

		return `Tool "${toolName}" is not allowed in ${phase} phase. Allowed tools: ${PHASE_CONFIGS[phase].allowedTools.join(", ")}`
	}

	/**
	 * Get repository configuration for current instance
	 */
	getRepositoryConfig(): RepositoryConfig {
		return this.repositoryConfig
	}

	/**
	 * Get phase configuration for current phase
	 */
	getPhaseConfig(): PhaseConfig {
		return PHASE_CONFIGS[this.state.phase]
	}

	/**
	 * Generate contextual guidance for current state
	 */
	generateGuidance(): string {
		return this.getPhaseGuidance()
	}

	/**
	 * Validate tool parameters against repository-specific rules
	 */
	validateToolParameters(_toolName: ToolName, _params: Record<string, unknown>): ValidationResult {
		// Basic validation - can be enhanced with repository-specific rules
		return {
			allowed: true,
			severity: "info",
		}
	}

	/**
	 * Check understanding requirement for tool usage
	 */
	checkUnderstandingRequirement(_toolName: ToolName): UnderstandingCheck {
		const config = this.repositoryConfig
		const understandingCheck = checkUnderstandingRequirement(
			this.state.readCallsCount,
			this.state.testCallsCount,
			config,
		)

		return {
			sufficient: understandingCheck.sufficient,
			readCallsCount: this.state.readCallsCount,
			testCallsCount: this.state.testCallsCount,
			requiredCalls: config.minReadCalls + config.minTestCalls,
			recommendation: understandingCheck.recommendation,
		}
	}

	/**
	 * Check if transition to a specific phase is allowed
	 */
	canTransitionTo(phase: SWEBenchPhase): boolean {
		// Basic transition logic - can be enhanced with repository-specific rules
		const currentPhase = this.state.phase

		switch (phase) {
			case "ANALYZE":
				return true // Can always go back to analyze
			case "MODIFY":
				return currentPhase === "ANALYZE" && this.state.hasRunTests
			case "VERIFY":
				return currentPhase === "MODIFY" && this.state.modificationCount > 0
			default:
				return false
		}
	}

	/**
	 * Force transition to a specific phase with reason
	 */
	forceTransition(phase: SWEBenchPhase, reason: string): void {
		console.log(`[SWEBench] Forced transition: ${this.state.phase} -> ${phase} (${reason})`)
		this.state = { ...this.state, phase }
		this.updateReasoningConfig()
	}

	/**
	 * Validate attempt_completion requirements based on current state
	 */
	private validateAttemptCompletion(): string | null {
		const state = this.state

		// Must be in VERIFY phase
		if (state.phase !== "VERIFY") {
			return this.getAttemptCompletionBlockReason(state.phase)
		}

		// In VERIFY phase, always allow completion
		// Let the agent decide if their solution is ready
		return null
	}

	/**
	 * Get specific block reason for attempt_completion in different phases
	 */
	private getAttemptCompletionBlockReason(phase: SWEBenchPhase): string {
		switch (phase) {
			case "ANALYZE":
				return "Cannot attempt completion in ANALYZE phase. You should explore the problem and understand what needs to be implemented first."
			case "MODIFY":
				return this.getAttemptCompletionBlockReasonInModify()
			default:
				return `Cannot attempt completion in ${phase} phase. Complete the workflow steps first.`
		}
	}

	private getAttemptCompletionBlockReasonInModify(): string {
		const base =
			"Cannot attempt completion in MODIFY phase. After making code changes, you should transition to VERIFY phase to validate your solution."

		// If we haven't modified anything yet, the user likely tried to finish prematurely.
		if (this.state.modificationCount <= 0) {
			return base
		}

		const remaining = Math.max(0, SWEBENCH_VERIFY_EXECUTE_COMMANDS_REQUIRED - (this.state.testCallsCount ?? 0))
		if (remaining <= 0) {
			return base
		}

		return `${base} You still need to run execute_command (bash) ${remaining} more time(s) to transition to VERIFY automatically.

🔍 Review & readiness checklist before the next test run:
1) Run \`git diff --stat\` followed by \`git diff\`. Confirm only the intended modules changed and there are no accidental edits or missing files.
2) Perform a structured code review (sequential-thinking MCP or your own checklist) that covers Behavior/Functionality, Data/Edge Cases, and Performance/Regression. Ensure the implementation matches the bug description item by item. If multiple files changed, record comment-style conclusions per file.
3) Close the loop: modification ➜ FAIL_TO_PASS (F2P) re-test ➜ PASS_TO_PASS (P2P) regression tests ➜ review logs to ensure no new warnings.
4) If the review surfaces issues, fix them yourself before proceeding; do not skip the verification steps.

After these checks, run the remaining execute_command calls to unlock VERIFY.`
	}

	/**
	 * Get the current reasoning configuration for the current phase
	 */
	getCurrentReasoningConfig(): SWEBenchReasoningConfig | undefined {
		return this.state.currentReasoningConfig
	}

	/**
	 * Update reasoning configuration when phase changes
	 */
	private updateReasoningConfig(): void {
		const phaseConfig = PHASE_CONFIGS[this.state.phase]
		if (phaseConfig.reasoningConfig) {
			const nextConfig: SWEBenchReasoningConfig = { ...phaseConfig.reasoningConfig }
			const maxBudget = nextConfig.reasoningBudget
			if (typeof maxBudget === "number") {
				nextConfig.reasoningBudget = computeDynamicReasoningBudget(maxBudget, this.state.toolCallsCount ?? 0)
			}
			this.state.currentReasoningConfig = nextConfig
			console.log(
				`[SWEBench] Updated reasoning config for ${this.state.phase} phase:`,
				this.state.currentReasoningConfig,
			)
		}
	}

	/**
	 * Record that a tool was used and potentially transition phases
	 */
	recordToolUse(toolName: ToolName, params?: Record<string, unknown>, output?: string): void {
		let newState = { ...this.state }

		// Track total tool usage count (used for dynamic reasoning budget scaling)
		newState.toolCallsCount = (newState.toolCallsCount ?? 0) + 1

		// Track basic counters
		if (toolName === "read_file") {
			newState.readCallsCount++
		}

		// Track all execute_command calls
		if (toolName === "execute_command") {
			const command = params?.command ? String(params.command) : undefined

			newState.testsRunCount++
			newState.lastTestOutput = output ?? null
			newState.hasRunTests = true

			if (command) {
				console.log(`[SWEBench] Command execution detected: ${command}`)
			} else {
				console.log(`[SWEBench] Command execution detected (command text unavailable)`)
			}

			// Transition immediately after any command execution – SWE runner ensures these are test invocations
			if (newState.phase === "ANALYZE") {
				newState.phase = "MODIFY"
				console.log(`[SWEBench] Phase transition: ANALYZE -> MODIFY (command execution)`)
			}
		}

		// Track execute_command calls in MODIFY phase after modifications for phase transition
		// Only count commands after code has been modified
		if (newState.phase === "MODIFY" && newState.modificationCount > 0) {
			newState.testCallsCount++

			// Transition to VERIFY after enough execute_command calls (after modifications)
			if (newState.testCallsCount >= SWEBENCH_VERIFY_EXECUTE_COMMANDS_REQUIRED) {
				newState.phase = "VERIFY"
				console.log(
					`[SWEBench] Phase transition: MODIFY -> VERIFY (modifications: ${newState.modificationCount}, commands after mod: ${newState.testCallsCount})`,
				)
				// Transition to VERIFY after enough execute_command calls (after modifications)
				if (newState.testCallsCount >= SWEBENCH_VERIFY_EXECUTE_COMMANDS_REQUIRED) {
					newState.phase = "VERIFY"
					console.log(
						`[SWEBench] Phase transition: MODIFY -> VERIFY (modifications: ${newState.modificationCount}, commands after mod: ${newState.testCallsCount})`,
					)
				}
			}
		}

		// Track code modifications
		if (isCodeModificationTool(toolName)) {
			newState.modificationCount++
			const filePath = params?.path ? String(params.path) : "unknown"
			console.log(`[SWEBench] Code modification: ${toolName} on ${filePath}`)

			if (filePath !== "unknown" && !newState.modifiedFiles.includes(filePath)) {
				newState.modifiedFiles = [...newState.modifiedFiles, filePath]
			}

			// After modification, don't immediately transition to VERIFY
			// Wait for execute_command calls to allow agent to verify changes
			// Transition will happen after 5 execute_command calls (see execute_command handling above)
		}

		// Handle completion attempt
		if (toolName === "attempt_completion") {
			newState.attemptCompletionCount++
			console.log(`[SWEBench] attempt_completion called (count: ${newState.attemptCompletionCount})`)
		}

		// Apply the new state
		this.state = newState
		this.updateReasoningConfig()

		// Update modified files list using git diff
		if (this.state.phase === "MODIFY" || this.state.phase === "VERIFY") {
			this.updateModifiedFilesFromGit()
		}
	}

	/**
	 * Force transition to a specific phase (for recovery/override scenarios)
	 */
	forcePhase(phase: SWEBenchPhase): void {
		this.state = { ...this.state, phase }
		this.updateReasoningConfig()
	}

	/**
	 * Get a status summary for logging/debugging
	 */
	getStatusSummary(): string {
		return `[SWEBench State] Phase: ${this.state.phase}, Tests Run: ${this.state.testsRunCount}, Modifications: ${this.state.modificationCount}, Tests Passed: ${this.state.testsPassedAfterModify}`
	}

	/**
	 * Check if project exploration is adequately completed
	 */
	isProjectExplorationComplete(): boolean {
		return this.state.projectExplored || (this.state.readmeRead && this.state.testStructureExplored)
	}

	/**
	 * Get project exploration status for guidance
	 */
	getProjectExplorationStatus(): {
		readmeRead: boolean
		testStructureExplored: boolean
		targetTestsLocated: boolean
		overallComplete: boolean
	} {
		return {
			readmeRead: this.state.readmeRead,
			testStructureExplored: this.state.testStructureExplored,
			targetTestsLocated: this.state.targetTestsLocated,
			overallComplete: this.isProjectExplorationComplete(),
		}
	}

	/**
	 * Get phase-specific guidance for the model
	 */
	getPhaseGuidance(): string {
		// Use the new modular prompt system
		return generatePhaseGuidance(this.state, this.state.instanceId)
	}

	/**
	 * Serialize state for persistence
	 */
	serialize(): string {
		return JSON.stringify(this.state)
	}

	/**
	 * Update modified files list using git diff (more reliable than tool parameters)
	 * In test environments or when git is not available, falls back to tool parameter tracking
	 */
	private updateModifiedFilesFromGit(): void {
		// Skip git diff in test environments
		if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") {
			return
		}

		try {
			const { execSync } = require("child_process")

			// Get modified files (both staged and unstaged)
			const gitDiffOutput = execSync("git diff --name-only HEAD", {
				encoding: "utf8",
				timeout: 5000,
				cwd: process.cwd(),
			}).trim()

			if (gitDiffOutput) {
				const modifiedFiles = gitDiffOutput.split("\n").filter((file: string) => file.trim())

				// Update state with actual modified files (merge with existing)
				this.state.modifiedFiles = [...new Set([...this.state.modifiedFiles, ...modifiedFiles])]

				console.log(`[SWEBench] Updated modified files from git: ${modifiedFiles.join(", ")}`)
			}
		} catch (error) {
			// Silently ignore git errors (might not be in a git repo)
			console.log(`[SWEBench] Could not update modified files from git: ${error}`)
		}
	}

	/**
	 * Set instance ID for instance-specific guidance
	 */
	setInstanceId(instanceId: string): void {
		this.state = {
			...this.state,
			instanceId,
			repositoryType: this.repositoryConfig.projectType,
		}
		this.repositoryConfig = getRepositoryConfig(instanceId)
		console.log(`[SWEBench] Instance ID set: ${instanceId}`)
	}

	/**
	 * Get recommended test command for current instance
	 */
	getRecommendedTestCommand(testName?: string): string | null {
		if (!this.state.instanceId) return null
		return getRecommendedTestCommand(this.state.instanceId, testName)
	}

	/**
	 * Analyze test command with repository-specific intelligence
	 */
	analyzeTestCommand(command: string): TestCommandAnalysis {
		return this.testAnalyzer.analyzeCommand(command, this.repositoryConfig)
	}

	/**
	 * Classify test execution results with repository context
	 */
	categorizeTestExecution(command: string, output: string): TestClassification {
		const classification = this.testAnalyzer.classifyTestExecution(command, output, this.repositoryConfig)

		// Track effectiveness for learning
		this.testAnalyzer.trackEffectiveness(command, this.repositoryConfig.repo, classification.success, output)

		return classification
	}

	/**
	 * Get test command effectiveness statistics for current repository
	 */
	getTestEffectivenessStats(): {
		totalCommands: number
		successRate: number
		commonIssues: string[]
		bestCommands: string[]
	} {
		return this.testAnalyzer.getEffectivenessStats(this.repositoryConfig.repo)
	}

	/**
	 * Get exploration recommendations for current state
	 */
	getExplorationRecommendations() {
		return this.explorationStrategy.getExplorationRecommendations(this.state)
	}

	/**
	 * Assess modification readiness with flexible requirements
	 */
	assessModificationReadiness() {
		return this.explorationStrategy.assessModificationReadiness(this.state, this.repositoryConfig)
	}

	/**
	 * Get escalated guidance based on understanding level
	 */
	getEscalatedGuidance(): string {
		return this.guidanceEscalator.getEscalatedGuidance(this.state, this.repositoryConfig, this.explorationStrategy)
	}

	/**
	 * Reset guidance escalation (useful for new tasks)
	 */
	resetGuidanceEscalation(): void {
		this.guidanceEscalator.reset()
	}

	/**
	 * Restore state from serialized form
	 */
	static deserialize(serialized: string, instanceId?: string): SWEBenchStateMachine {
		const state = JSON.parse(serialized) as SWEBenchState
		return new SWEBenchStateMachine(state, instanceId)
	}
}
