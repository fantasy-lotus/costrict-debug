/**
 * Enhanced Test Command Analysis System
 *
 * Provides instance-prompt powered test command recognition, confidence scoring,
 * and repository-specific validation for SWE-bench tasks.
 *
 * Extends the existing basic test command detection with repository-aware intelligence.
 */

import type { RepositoryConfig } from "./repository-config"
import { getRepoTestGuidance, type RepoTestGuidance } from "./instance-prompts"

/**
 * Test command analysis result with confidence scoring
 */
export interface TestCommandAnalysis {
	/** Whether this appears to be a test command */
	readonly isTestCommand: boolean
	/** Confidence score from 0.0 to 1.0 */
	readonly confidence: number
	/** Type of test execution */
	readonly testType: TestType
	/** Whether command matches repository-specific patterns */
	readonly repositoryMatch: boolean
	/** Suggested improvements to the command */
	readonly suggestedImprovements: string[]
	/** Alternative commands that might work better */
	readonly alternativeCommands: string[]
	/** Reasoning for the analysis */
	readonly reasoning: string
}

/**
 * Test execution classification result
 */
export interface TestClassification {
	/** Category of test execution */
	readonly category: TestCategory
	/** Confidence in the classification */
	readonly confidence: number
	/** Reasoning for the classification */
	readonly reasoning: string
	/** Repository-specific context */
	readonly repositoryContext: string
	/** Detected test names from output */
	readonly detectedTests: string[]
	/** Whether tests passed or failed */
	readonly success: boolean
}

/**
 * Repository pattern matching result
 */
export interface PatternMatch {
	/** Whether the command matches repository patterns */
	readonly matches: boolean
	/** Which specific patterns were matched */
	readonly matchedPatterns: string[]
	/** Confidence in the match */
	readonly confidence: number
	/** Whether this is repository-specific or generic */
	readonly repositorySpecific: boolean
}

/**
 * Test command effectiveness tracking
 */
export interface TestEffectiveness {
	/** Command that was executed */
	readonly command: string
	/** Repository it was used on */
	readonly repository: string
	/** Whether it executed successfully */
	readonly executionSuccess: boolean
	/** Whether it provided useful test results */
	readonly resultQuality: "excellent" | "good" | "poor" | "failed"
	/** Timestamp of execution */
	readonly timestamp: number
	/** Any issues encountered */
	readonly issues: string[]
}

/**
 * Types of test execution
 */
export type TestType = "f2p" | "p2p" | "discovery" | "validation" | "exploration" | "unknown"

/**
 * Categories of test execution
 */
export type TestCategory = "f2p" | "p2p" | "discovery" | "validation" | "exploration" | "unknown"

/**
 * Enhanced test command analyzer with instance-prompt intelligence
 */
export class InstancePromptTestAnalyzer {
	private effectivenessHistory: TestEffectiveness[] = []

	/**
	 * Analyze a command to determine if it's a test command and provide insights
	 */
	analyzeCommand(command: string, repositoryConfig: RepositoryConfig): TestCommandAnalysis {
		const guidance = this.getRepositoryGuidance(repositoryConfig)

		// Basic test command detection
		const basicAnalysis = this.performBasicAnalysis(command)

		// Repository-specific pattern matching
		const patternMatch = this.matchesRepositoryPatterns(command, guidance)

		// Confidence calculation
		const confidence = this.calculateConfidence(basicAnalysis, patternMatch, guidance)

		// Generate suggestions and alternatives
		const suggestions = this.generateSuggestions(command, guidance, patternMatch)
		const alternatives = this.generateAlternatives(command, guidance)

		// Determine test type
		const testType = this.determineTestType(command, guidance)

		// Generate reasoning
		const reasoning = this.generateReasoning(command, basicAnalysis, patternMatch, guidance)

		return {
			isTestCommand: basicAnalysis.isTestCommand || patternMatch.matches,
			confidence,
			testType,
			repositoryMatch: patternMatch.repositorySpecific,
			suggestedImprovements: suggestions,
			alternativeCommands: alternatives,
			reasoning,
		}
	}

	/**
	 * Classify test execution results with repository context
	 */
	classifyTestExecution(command: string, output: string, repositoryConfig: RepositoryConfig): TestClassification {
		const guidance = this.getRepositoryGuidance(repositoryConfig)

		// Analyze output for test results
		const outputAnalysis = this.analyzeTestOutput(output, guidance)

		// Determine category based on command and output
		const category = this.categorizeExecution(command, output, guidance)

		// Calculate confidence
		const confidence = this.calculateClassificationConfidence(outputAnalysis, category)

		// Generate reasoning and context
		const reasoning = this.generateClassificationReasoning(command, output, category, guidance)
		const repositoryContext = this.generateRepositoryContext(guidance, outputAnalysis)

		return {
			category,
			confidence,
			reasoning,
			repositoryContext,
			detectedTests: outputAnalysis.detectedTests,
			success: outputAnalysis.success,
		}
	}

	/**
	 * Check if command matches repository-specific patterns
	 */
	matchesRepositoryPatterns(command: string, guidance: RepoTestGuidance): PatternMatch {
		const matchedPatterns: string[] = []
		let repositorySpecific = false

		// Handle empty commands
		if (!command || command.trim() === "") {
			return {
				matches: false,
				matchedPatterns: [],
				confidence: 0.0,
				repositorySpecific: false,
			}
		}

		// Check against repository's test runner
		if (guidance.testRunner !== "auto-detect" && command.includes(guidance.testRunner)) {
			matchedPatterns.push(`testRunner: ${guidance.testRunner}`)
			repositorySpecific = true
		}

		// Check against example commands
		for (const example of guidance.examples) {
			if (this.commandsSimilar(command, example)) {
				matchedPatterns.push(`example: ${example}`)
				repositorySpecific = true
			}
		}

		// Check for project-specific patterns (only if not auto-detect)
		if (guidance.testRunner !== "auto-detect") {
			const projectPatterns = this.getProjectSpecificPatterns(guidance.projectType)
			for (const pattern of projectPatterns) {
				if (pattern.test(command)) {
					matchedPatterns.push(`projectPattern: ${pattern.source}`)
					repositorySpecific = true
				}
			}
		}

		// Generic test patterns (fallback)
		if (!repositorySpecific) {
			const genericPatterns = this.getGenericTestPatterns()
			for (const pattern of genericPatterns) {
				if (pattern.test(command)) {
					matchedPatterns.push(`generic: ${pattern.source}`)
				}
			}
		}

		const matches = matchedPatterns.length > 0
		const confidence = repositorySpecific ? 0.9 : matches ? 0.6 : 0.0

		return {
			matches,
			matchedPatterns,
			confidence,
			repositorySpecific,
		}
	}

	/**
	 * Track test command effectiveness for learning
	 */
	trackEffectiveness(command: string, repository: string, executionSuccess: boolean, output: string): void {
		const resultQuality = this.assessResultQuality(output, executionSuccess)
		const issues = this.extractIssues(output)

		const effectiveness: TestEffectiveness = {
			command,
			repository,
			executionSuccess,
			resultQuality,
			timestamp: Date.now(),
			issues,
		}

		this.effectivenessHistory.push(effectiveness)

		// Keep only recent history (last 100 entries)
		if (this.effectivenessHistory.length > 100) {
			this.effectivenessHistory = this.effectivenessHistory.slice(-100)
		}
	}

	/**
	 * Get effectiveness statistics for a repository
	 */
	getEffectivenessStats(repository: string): {
		totalCommands: number
		successRate: number
		commonIssues: string[]
		bestCommands: string[]
	} {
		const repoHistory = this.effectivenessHistory.filter((h) => h.repository === repository)

		const totalCommands = repoHistory.length
		const successRate = totalCommands > 0 ? repoHistory.filter((h) => h.executionSuccess).length / totalCommands : 0

		// Extract common issues
		const allIssues = repoHistory.flatMap((h) => h.issues)
		const issueCounts = new Map<string, number>()
		for (const issue of allIssues) {
			issueCounts.set(issue, (issueCounts.get(issue) || 0) + 1)
		}
		const commonIssues = Array.from(issueCounts.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([issue]) => issue)

		// Find best performing commands
		const commandSuccess = new Map<string, { total: number; success: number }>()
		for (const history of repoHistory) {
			const stats = commandSuccess.get(history.command) || { total: 0, success: 0 }
			stats.total++
			if (history.executionSuccess && history.resultQuality !== "failed") {
				stats.success++
			}
			commandSuccess.set(history.command, stats)
		}

		const bestCommands = Array.from(commandSuccess.entries())
			.filter(([, stats]) => stats.total >= 2 && stats.success > 0) // At least 2 uses and some success
			.sort((a, b) => b[1].success / b[1].total - a[1].success / a[1].total)
			.slice(0, 3)
			.map(([command]) => command)

		return {
			totalCommands,
			successRate,
			commonIssues,
			bestCommands,
		}
	}

	// Private helper methods

	private getRepositoryGuidance(repositoryConfig: RepositoryConfig): RepoTestGuidance {
		// Use the repository config's repo field to get guidance
		return getRepoTestGuidance(repositoryConfig.repo || "")
	}

	private performBasicAnalysis(command: string): { isTestCommand: boolean } {
		// Handle empty commands
		if (!command || command.trim() === "") {
			return { isTestCommand: false }
		}

		// Use existing basic test command patterns
		const testPatterns = [
			/python\s+-m\s+pytest/i,
			/(?:^|[;&|]\s*)pytest\b/i,
			/python\s+-m\s+unittest/i,
			/(?:^|\s)(?:python\s+)?(?:\.\/)?(?:tests\/)?runtests\.py\b/i,
			/(?:^|[;&|]\s*)tox\b/i,
			/manage\.py\s+test/i,
			/make\s+test/i,
			/python\s+bin\/test/i,
		]

		const isTestCommand = testPatterns.some((pattern) => pattern.test(command))
		return { isTestCommand }
	}

	private calculateConfidence(
		basicAnalysis: { isTestCommand: boolean },
		patternMatch: PatternMatch,
		guidance: RepoTestGuidance,
	): number {
		let confidence = 0.0

		// Base confidence from basic analysis
		if (basicAnalysis.isTestCommand) {
			confidence += 0.4
		}

		// Boost for repository-specific matches
		if (patternMatch.repositorySpecific) {
			confidence += 0.5
		} else if (patternMatch.matches) {
			confidence += 0.2
		}

		// Boost for exact test runner match
		if (
			guidance.testRunner !== "auto-detect" &&
			patternMatch.matchedPatterns.some((p) => p.includes("testRunner"))
		) {
			confidence += 0.1
		}

		return Math.min(confidence, 1.0)
	}

	private generateSuggestions(command: string, guidance: RepoTestGuidance, patternMatch: PatternMatch): string[] {
		const suggestions: string[] = []

		// If not repository-specific, suggest using the official test runner
		if (!patternMatch.repositorySpecific && guidance.testRunner !== "auto-detect") {
			suggestions.push(`Use the official test runner: ${guidance.testRunner}`)
		}

		// Suggest verbosity flags if missing
		if (!command.includes("-v") && !command.includes("--verbose") && guidance.projectType === "pytest") {
			suggestions.push("Add -v flag for verbose output")
		}

		// Django-specific suggestions
		if (guidance.projectType === "django" && command.includes("runtests.py")) {
			if (!command.includes("--verbosity")) {
				suggestions.push("Add --verbosity 2 for detailed output")
			}
			if (!command.includes("--settings")) {
				suggestions.push("Add --settings=test_sqlite for consistent test environment")
			}
		}

		// Pytest-specific suggestions
		if (guidance.projectType === "pytest") {
			if (!command.includes("-x") && !command.includes("--maxfail")) {
				suggestions.push("Consider adding -x to stop on first failure")
			}
		}

		return suggestions
	}

	private generateAlternatives(command: string, guidance: RepoTestGuidance): string[] {
		const alternatives: string[] = []

		// Always suggest the primary examples as alternatives
		if (guidance.examples.length > 0) {
			// Add up to 3 most relevant examples
			alternatives.push(...guidance.examples.slice(0, 3))
		}

		// If command seems generic, suggest repository-specific alternatives
		if (guidance.testRunner !== "auto-detect" && !command.includes(guidance.testRunner)) {
			alternatives.push(guidance.testRunner)
		}

		return alternatives.filter((alt) => alt !== command) // Don't suggest the same command
	}

	private determineTestType(command: string, guidance: RepoTestGuidance): TestType {
		// Help or discovery commands first
		if (command.includes("--help") || command.includes("-h") || command.includes("--collect-only")) {
			return "discovery"
		}

		// Broad test runs are likely P2P regression tests - check this first
		if (command === guidance.testRunner || guidance.examples.includes(command)) {
			return "p2p"
		}

		// Check if command is similar to examples (broad test runs)
		for (const example of guidance.examples) {
			if (this.commandsSimilar(command, example)) {
				return "p2p"
			}
		}

		// Look for specific test names or patterns in the command
		if (command.includes("test_") || command.includes("::test_")) {
			return "f2p" // Likely targeting specific tests
		}

		return "unknown"
	}

	private generateReasoning(
		command: string,
		basicAnalysis: { isTestCommand: boolean },
		patternMatch: PatternMatch,
		guidance: RepoTestGuidance,
	): string {
		const reasons: string[] = []

		if (basicAnalysis.isTestCommand) {
			reasons.push("matches generic test command patterns")
		}

		if (patternMatch.repositorySpecific) {
			reasons.push(`matches ${guidance.repo} repository-specific patterns`)
		}

		if (patternMatch.matchedPatterns.length > 0) {
			reasons.push(`matched patterns: ${patternMatch.matchedPatterns.join(", ")}`)
		}

		if (reasons.length === 0) {
			reasons.push("does not match known test command patterns")
		}

		return `Command analysis: ${reasons.join("; ")}`
	}

	private analyzeTestOutput(
		output: string,
		guidance: RepoTestGuidance,
	): {
		success: boolean
		detectedTests: string[]
		hasResults: boolean
	} {
		// Framework-specific output analysis
		let success = false
		const detectedTests: string[] = []
		let hasResults = false

		// Universal success/failure patterns
		const successPatterns = [/OK\s*$/m, /\d+\s+passed/i, /All tests passed/i, /0 failed/i]

		const failurePatterns = [/FAILED/i, /ERROR/i, /FAILURE/i, /AssertionError/i, /\d+\s+failed/i]

		// Check for test execution indicators
		const executionPatterns = [
			/Ran \d+ tests? in/i,
			/collected \d+ items?/i,
			/test session starts/i,
			/=+ FAILURES =+/i,
			/=+ ERRORS =+/i,
		]

		hasResults = executionPatterns.some((pattern) => pattern.test(output))
		success =
			successPatterns.some((pattern) => pattern.test(output)) &&
			!failurePatterns.some((pattern) => pattern.test(output))

		// Extract test names
		const testNamePatterns = [/test_\w+/g, /::\w+.*(?:PASSED|FAILED|ERROR)/g, /FAIL(?:ED)?:\s*([^\n]+)/g]

		for (const pattern of testNamePatterns) {
			const matches = output.match(pattern)
			if (matches) {
				detectedTests.push(...matches)
			}
		}

		return { success, detectedTests: [...new Set(detectedTests)], hasResults }
	}

	private categorizeExecution(command: string, output: string, guidance: RepoTestGuidance): TestCategory {
		// Help or discovery commands first
		if (command.includes("--help") || command.includes("--collect-only")) {
			return "discovery"
		}

		// Analyze command to determine intent
		if (command.includes("test_") || command.includes("::test_")) {
			return "f2p" // Specific test targeting
		}

		// Analyze output for clues
		const outputAnalysis = this.analyzeTestOutput(output, guidance)
		if (outputAnalysis.hasResults) {
			// If it's a broad test run, likely P2P
			if (command === guidance.testRunner || guidance.examples.includes(command)) {
				return "p2p"
			}

			// Check if command is similar to examples (broad test runs)
			for (const example of guidance.examples) {
				if (this.commandsSimilar(command, example)) {
					return "p2p"
				}
			}

			return "validation"
		}

		return "exploration"
	}

	private calculateClassificationConfidence(
		outputAnalysis: { success: boolean; hasResults: boolean },
		category: TestCategory,
	): number {
		let confidence = 0.5 // Base confidence

		if (outputAnalysis.hasResults) {
			confidence += 0.3 // Clear test execution
		}

		if (category !== "unknown") {
			confidence += 0.2 // Clear categorization
		}

		return Math.min(confidence, 1.0)
	}

	private generateClassificationReasoning(
		command: string,
		output: string,
		category: TestCategory,
		guidance: RepoTestGuidance,
	): string {
		const reasons: string[] = []

		reasons.push(`categorized as ${category}`)

		if (command.includes("test_")) {
			reasons.push("command targets specific tests")
		}

		if (output.includes("passed") || output.includes("failed")) {
			reasons.push("output contains test results")
		}

		return reasons.join("; ")
	}

	private generateRepositoryContext(guidance: RepoTestGuidance, outputAnalysis: any): string {
		return `Repository: ${guidance.repo} (${guidance.projectType}), Test runner: ${guidance.testRunner}`
	}

	private commandsSimilar(cmd1: string, cmd2: string): boolean {
		// Simple similarity check - could be enhanced
		const normalize = (cmd: string) => cmd.toLowerCase().replace(/\s+/g, " ").trim()
		const norm1 = normalize(cmd1)
		const norm2 = normalize(cmd2)

		// Check if one contains the other or they share significant parts
		return norm1.includes(norm2) || norm2.includes(norm1) || this.calculateSimilarity(norm1, norm2) > 0.7
	}

	private calculateSimilarity(str1: string, str2: string): number {
		// Simple Jaccard similarity on words
		const words1 = new Set(str1.split(" "))
		const words2 = new Set(str2.split(" "))
		const intersection = new Set([...words1].filter((x) => words2.has(x)))
		const union = new Set([...words1, ...words2])
		return intersection.size / union.size
	}

	private getProjectSpecificPatterns(projectType: string): RegExp[] {
		switch (projectType) {
			case "django":
				return [/\.\/tests\/runtests\.py/i, /manage\.py\s+test/i, /--settings=test_sqlite/i]
			case "pytest":
				return [/python\s+-m\s+pytest/i, /pytest\s+/i, /-v\b/i, /--tb=long/i]
			case "custom":
				return [/python\s+bin\/test/i, /make\s+test/i, /\.\/runtests\.py/i]
			default:
				return []
		}
	}

	private getGenericTestPatterns(): RegExp[] {
		return [/test/i, /python\s+-m/i, /\.py\b/i]
	}

	private assessResultQuality(output: string, executionSuccess: boolean): "excellent" | "good" | "poor" | "failed" {
		if (!executionSuccess) {
			return "failed"
		}

		// Check for clear test results
		if (/Ran \d+ tests?|collected \d+ items?|\d+ passed|\d+ failed/i.test(output)) {
			return "excellent"
		}

		// Check for some test output
		if (/test|OK|PASSED|FAILED/i.test(output)) {
			return "good"
		}

		return "poor"
	}

	private extractIssues(output: string): string[] {
		const issues: string[] = []

		if (/No module named/i.test(output)) {
			issues.push("Missing module dependency")
		}

		if (/command not found/i.test(output)) {
			issues.push("Command not available")
		}

		if (/ImportError|ModuleNotFoundError/i.test(output)) {
			issues.push("Import error")
		}

		if (/SyntaxError/i.test(output)) {
			issues.push("Syntax error in code")
		}

		if (/Permission denied/i.test(output)) {
			issues.push("Permission issue")
		}

		return issues
	}
}

/**
 * Create a test analyzer instance
 */
export function createTestAnalyzer(): InstancePromptTestAnalyzer {
	return new InstancePromptTestAnalyzer()
}

/**
 * Analyze a test command with repository context
 */
export function analyzeTestCommand(command: string, repositoryConfig: RepositoryConfig): TestCommandAnalysis {
	const analyzer = createTestAnalyzer()
	return analyzer.analyzeCommand(command, repositoryConfig)
}

/**
 * Classify test execution results
 */
export function classifyTestExecution(
	command: string,
	output: string,
	repositoryConfig: RepositoryConfig,
): TestClassification {
	const analyzer = createTestAnalyzer()
	return analyzer.classifyTestExecution(command, output, repositoryConfig)
}
