/**
 * Flexible Analysis Phase System for SWE-bench
 *
 * Provides recommendation-based exploration guidance instead of hard requirements,
 * with understanding-based modification gates and progressive guidance escalation.
 */

import type { RepositoryConfig } from "./repository-config"

export type ExplorationPriority = "low" | "medium" | "high" | "critical"
export type UnderstandingLevel = "insufficient" | "basic" | "adequate" | "comprehensive"
export type GuidanceIntensity = "minimal" | "standard" | "detailed" | "comprehensive"

export interface ExplorationRecommendation {
	readonly action: string
	readonly priority: ExplorationPriority
	readonly reason: string
	readonly benefit: string
}

export interface ModificationReadiness {
	readonly ready: boolean
	readonly readCallsCount: number
	readonly testCallsCount: number
	readonly requiredCalls: number
	readonly blockingFactors: string[]
	readonly recommendations: string[]
}

export interface UnderstandingAssessment {
	readonly level: UnderstandingLevel
	readonly score: number // 0-100
	readonly factors: UnderstandingFactor[]
	readonly recommendations: ExplorationRecommendation[]
}

export interface UnderstandingFactor {
	readonly category: "exploration" | "testing" | "documentation" | "structure"
	readonly weight: number
	readonly achieved: boolean
	readonly description: string
}

export interface ExplorationState {
	readonly readmeRead: boolean
	readonly testStructureExplored: boolean
	readonly targetTestsLocated: boolean
	readonly configurationUnderstood: boolean
	readonly repositoryMapped: boolean
	readonly explorationScore: number
	readonly recommendedActions: string[]
}

export interface FlexibleExplorationStrategy {
	/**
	 * Get exploration recommendations based on current state
	 */
	getExplorationRecommendations(state: any): ExplorationRecommendation[]

	/**
	 * Assess readiness for code modifications
	 */
	assessModificationReadiness(state: any, repositoryConfig: RepositoryConfig): ModificationReadiness

	/**
	 * Determine guidance level based on understanding
	 */
	getGuidanceLevel(understandingLevel: UnderstandingLevel): GuidanceIntensity

	/**
	 * Determine understanding level based on state
	 */
	determineUnderstandingLevel(state: any, repositoryConfig: RepositoryConfig): UnderstandingLevel

	/**
	 * Assess overall understanding level
	 */
	assessUnderstanding(state: any, executionHistory: ToolExecutionRecord[]): UnderstandingAssessment

	/**
	 * Generate progressive guidance based on repeated insufficient attempts
	 */
	generateProgressiveGuidance(attemptCount: number, understandingLevel: UnderstandingLevel): string[]
}

export interface ToolExecutionRecord {
	readonly toolName: string
	readonly timestamp: number
	readonly params?: Record<string, unknown>
	readonly output?: string
	readonly success: boolean
}

/**
 * Default implementation of flexible exploration strategy
 */
export class DefaultFlexibleExplorationStrategy implements FlexibleExplorationStrategy {
	private static readonly MIN_READ_CALLS = 5
	private static readonly MIN_TEST_CALLS = 2
	private static readonly RECOMMENDED_READ_CALLS = 10
	private static readonly RECOMMENDED_TEST_CALLS = 3

	getExplorationRecommendations(state: any): ExplorationRecommendation[] {
		const recommendations: ExplorationRecommendation[] = []

		// Check README exploration
		if (!state.readmeRead) {
			recommendations.push({
				action: "Read project README and documentation",
				priority: "high",
				reason: "Understanding project structure and setup is crucial",
				benefit: "Provides context for test execution and project conventions",
			})
		}

		// Check test structure exploration
		if (!state.testStructureExplored) {
			recommendations.push({
				action: "Explore test directory structure and configuration",
				priority: "high",
				reason: "Need to understand how tests are organized and executed",
				benefit: "Enables proper test discovery and execution strategies",
			})
		}

		// Check target test location
		if (!state.targetTestsLocated) {
			recommendations.push({
				action: "Locate and examine specific FAIL_TO_PASS test files",
				priority: "critical",
				reason: "Must identify the exact tests that need to pass",
				benefit: "Focuses modification efforts on relevant code paths",
			})
		}

		// Check configuration understanding
		if (!state.configurationUnderstood) {
			recommendations.push({
				action: "Examine project configuration files (setup.py, requirements.txt, etc.)",
				priority: "medium",
				reason: "Configuration affects test execution and dependencies",
				benefit: "Prevents environment-related test failures",
			})
		}

		// Check repository mapping
		if (!state.repositoryMapped) {
			recommendations.push({
				action: "Map key source files and their relationships",
				priority: "medium",
				reason: "Understanding code organization helps target modifications",
				benefit: "Reduces risk of unintended side effects",
			})
		}

		// Add progressive recommendations based on read calls
		const readCalls = state.readCallsCount || 0
		const testCalls = state.testCallsCount || 0

		if (readCalls < 5) {
			recommendations.push({
				action: "Read more source files to understand codebase structure",
				priority: "medium",
				reason: "Insufficient file exploration for safe modifications",
				benefit: "Builds comprehensive context for effective problem solving",
			})
		}

		if (readCalls >= 5 && testCalls === 0 && state.readmeRead && state.testStructureExplored) {
			recommendations.push({
				action: "Execute tests to understand current failure patterns",
				priority: "critical",
				reason: "Need to see actual test failures before making changes",
				benefit: "Guides targeted fixes rather than trial-and-error approaches",
			})
		}

		return recommendations.sort((a, b) => this.priorityWeight(b.priority) - this.priorityWeight(a.priority))
	}

	assessModificationReadiness(state: any, repositoryConfig: RepositoryConfig): ModificationReadiness {
		const readCalls = state.readCallsCount || 0
		const testCalls = state.testCallsCount || 0

		const blockingFactors: string[] = []
		const recommendations: string[] = []

		// Check minimum understanding requirements
		let ready = true

		if (readCalls < DefaultFlexibleExplorationStrategy.MIN_READ_CALLS) {
			ready = false
			blockingFactors.push(
				`Insufficient file exploration (${readCalls}/${DefaultFlexibleExplorationStrategy.MIN_READ_CALLS} minimum)`,
			)
			recommendations.push("Read more project files to understand codebase structure")
		}

		if (testCalls < DefaultFlexibleExplorationStrategy.MIN_TEST_CALLS) {
			ready = false
			if (testCalls === 0) {
				blockingFactors.push("No test execution performed yet")
			} else {
				blockingFactors.push(
					`Insufficient test execution (${testCalls}/${DefaultFlexibleExplorationStrategy.MIN_TEST_CALLS} minimum)`,
				)
			}
			recommendations.push("Execute tests to understand current failure patterns")
		}

		// Only check for target tests if we have some understanding but haven't located them yet
		if (
			!state.targetTestsLocated &&
			(readCalls >= DefaultFlexibleExplorationStrategy.MIN_READ_CALLS || testCalls >= 1)
		) {
			// Don't block if we have sufficient other understanding
			if (
				!(
					readCalls >= DefaultFlexibleExplorationStrategy.RECOMMENDED_READ_CALLS &&
					testCalls >= DefaultFlexibleExplorationStrategy.MIN_TEST_CALLS &&
					state.readmeRead &&
					state.testStructureExplored
				)
			) {
				ready = false
				blockingFactors.push("Target FAIL_TO_PASS tests not yet located")
				recommendations.push("Identify and examine the specific tests that need to pass")
			}
		}

		// Add recommendations for better understanding even if minimum met
		if (readCalls < DefaultFlexibleExplorationStrategy.RECOMMENDED_READ_CALLS) {
			recommendations.push(
				`Consider reading more files for better understanding (${readCalls}/${DefaultFlexibleExplorationStrategy.RECOMMENDED_READ_CALLS} recommended)`,
			)
		}

		if (testCalls < DefaultFlexibleExplorationStrategy.RECOMMENDED_TEST_CALLS) {
			recommendations.push(
				`Consider running more tests for better insight (${testCalls}/${DefaultFlexibleExplorationStrategy.RECOMMENDED_TEST_CALLS} recommended)`,
			)
		}

		return {
			ready,
			readCallsCount: readCalls,
			testCallsCount: testCalls,
			requiredCalls:
				DefaultFlexibleExplorationStrategy.MIN_READ_CALLS + DefaultFlexibleExplorationStrategy.MIN_TEST_CALLS,
			blockingFactors,
			recommendations,
		}
	}

	getGuidanceLevel(understandingLevel: UnderstandingLevel): GuidanceIntensity {
		switch (understandingLevel) {
			case "insufficient":
				return "comprehensive"
			case "basic":
				return "detailed"
			case "adequate":
				return "standard"
			case "comprehensive":
				return "minimal"
		}
	}

	determineUnderstandingLevel(state: any, repositoryConfig: RepositoryConfig): UnderstandingLevel {
		const readCalls = state.readCallsCount || 0
		const testCalls = state.testCallsCount || 0
		const readmeRead = state.readmeRead || false
		const testStructureExplored = state.testStructureExplored || false
		const projectExplored = state.projectExplored || false

		// Calculate understanding score based on multiple factors
		let score = 0

		// Reading activity (max 40 points)
		if (readCalls >= 25) score += 40
		else if (readCalls >= 12) score += 30
		else if (readCalls >= 6) score += 20
		else if (readCalls >= 3) score += 10

		// Test execution (max 30 points)
		if (testCalls >= 3) score += 30
		else if (testCalls >= 1) score += 15

		// Documentation (max 15 points)
		if (readmeRead) score += 15

		// Test structure (max 10 points)
		if (testStructureExplored) score += 10

		// Project exploration (max 5 points - bonus)
		if (projectExplored) score += 5

		// Classify based on score - adjusted thresholds
		if (score < 25) return "insufficient"
		if (score < 50) return "basic"
		if (score < 75) return "adequate"
		return "comprehensive"
	}

	assessUnderstanding(state: any, executionHistory: ToolExecutionRecord[]): UnderstandingAssessment {
		const factors: UnderstandingFactor[] = [
			{
				category: "documentation",
				weight: 20,
				achieved: state.readmeRead,
				description: "Project documentation and setup instructions",
			},
			{
				category: "testing",
				weight: 25,
				achieved: state.testStructureExplored,
				description: "Test framework and execution patterns",
			},
			{
				category: "exploration",
				weight: 30,
				achieved: state.targetTestsLocated,
				description: "Specific failing tests identification",
			},
			{
				category: "structure",
				weight: 15,
				achieved: state.repositoryMapped,
				description: "Codebase organization and relationships",
			},
			{
				category: "exploration",
				weight: 10,
				achieved: state.configurationUnderstood,
				description: "Project configuration and dependencies",
			},
		]

		const score = factors.reduce((total, factor) => {
			return total + (factor.achieved ? factor.weight : 0)
		}, 0)

		let level: UnderstandingLevel
		if (score < 30) {
			level = "insufficient"
		} else if (score < 60) {
			level = "basic"
		} else if (score < 85) {
			level = "adequate"
		} else {
			level = "comprehensive"
		}

		const recommendations = this.getExplorationRecommendations(state).filter(
			(rec) => rec.priority === "high" || rec.priority === "critical",
		)

		return {
			level,
			score,
			factors,
			recommendations,
		}
	}

	generateProgressiveGuidance(attemptCount: number, understandingLevel: UnderstandingLevel): string[] {
		const guidance: string[] = []

		if (attemptCount === 1) {
			guidance.push("Consider exploring the project more thoroughly before making modifications")
		} else if (attemptCount === 2) {
			guidance.push("Your understanding may be insufficient. Try reading more files and running tests")
			guidance.push("Focus on understanding the failing tests and their requirements")
		} else if (attemptCount >= 3) {
			guidance.push("Multiple modification attempts suggest insufficient understanding")
			guidance.push("Take time to thoroughly explore the project structure and test patterns")
			guidance.push("Consider reading documentation, configuration files, and related test files")
		}

		// Add understanding-specific guidance
		switch (understandingLevel) {
			case "insufficient":
				guidance.push("Your current understanding is insufficient for effective modifications")
				guidance.push("Focus on basic project exploration: README, test structure, and target tests")
				break
			case "basic":
				guidance.push("You have basic understanding but may need deeper insight")
				guidance.push("Examine the specific failing tests and related code more carefully")
				break
			case "adequate":
				guidance.push("Your understanding is adequate but could be improved")
				guidance.push("Consider exploring edge cases and related functionality")
				break
		}

		return guidance
	}

	private priorityWeight(priority: ExplorationPriority): number {
		switch (priority) {
			case "critical":
				return 4
			case "high":
				return 3
			case "medium":
				return 2
			case "low":
				return 1
		}
	}
}

/**
 * Repository-specific exploration strategies
 */
export class RepositoryAwareExplorationStrategy extends DefaultFlexibleExplorationStrategy {
	constructor(private repositoryType: string) {
		super()
	}

	override getExplorationRecommendations(state: any): ExplorationRecommendation[] {
		const baseRecommendations = super.getExplorationRecommendations(state)

		// Add repository-specific recommendations
		const repositorySpecific = this.getRepositorySpecificRecommendations(state)

		return [...baseRecommendations, ...repositorySpecific]
	}

	private getRepositorySpecificRecommendations(state: any): ExplorationRecommendation[] {
		const recommendations: ExplorationRecommendation[] = []

		switch (this.repositoryType.toLowerCase()) {
			case "django":
				if (!state.configurationUnderstood) {
					recommendations.push({
						action: "Examine Django settings.py and manage.py configuration",
						priority: "high",
						reason: "Django projects have specific configuration requirements",
						benefit: "Ensures tests run in correct Django environment",
					})
				}
				break

			case "pytest":
				if (!state.testStructureExplored) {
					recommendations.push({
						action: "Check pytest.ini, pyproject.toml, or setup.cfg for pytest configuration",
						priority: "medium",
						reason: "Pytest configuration affects test discovery and execution",
						benefit: "Ensures tests are run with correct pytest settings",
					})
				}
				break

			case "unittest":
				recommendations.push({
					action: "Look for unittest test discovery patterns and module structure",
					priority: "medium",
					reason: "Unittest has specific discovery conventions",
					benefit: "Helps locate and run tests using standard unittest patterns",
				})
				break
		}

		return recommendations
	}
}

/**
 * Factory for creating exploration strategies
 */
export class ExplorationStrategyFactory {
	static create(repositoryType?: string): FlexibleExplorationStrategy {
		if (repositoryType) {
			return new RepositoryAwareExplorationStrategy(repositoryType)
		}
		return new DefaultFlexibleExplorationStrategy()
	}
}

/**
 * Progressive Guidance Escalator
 *
 * Provides escalating guidance when agents repeatedly request help
 * without making progress on understanding the repository.
 */
export class ProgressiveGuidanceEscalator {
	private requestHistory: Array<{ timestamp: number; stateHash: string }> = []
	private escalationLevel = 0

	/**
	 * Get escalated guidance based on request history
	 */
	getEscalatedGuidance(
		state: any,
		repositoryConfig: RepositoryConfig,
		strategy: FlexibleExplorationStrategy,
	): string {
		const stateHash = this.hashState(state)
		const now = Date.now()

		// Check if this is a repeated request
		const recentRequests = this.requestHistory.filter(
			(req) => now - req.timestamp < 300000, // 5 minutes
		)

		const repeatedRequests = recentRequests.filter((req) => req.stateHash === stateHash).length

		// Record this request
		this.requestHistory.push({ timestamp: now, stateHash })

		// Clean old history
		this.requestHistory = this.requestHistory.filter(
			(req) => now - req.timestamp < 600000, // 10 minutes
		)

		// Determine escalation level
		if (repeatedRequests > 0) {
			this.escalationLevel = Math.min(repeatedRequests + 1, 5)
		} else {
			this.escalationLevel = 1
		}

		return this.generateEscalatedGuidance(state, repositoryConfig, strategy)
	}

	/**
	 * Reset escalation history
	 */
	reset(): void {
		this.requestHistory = []
		this.escalationLevel = 0
	}

	private hashState(state: any): string {
		// Create a simple hash of relevant state properties
		const relevantProps = {
			readCallsCount: state.readCallsCount || 0,
			testCallsCount: state.testCallsCount || 0,
			readmeRead: state.readmeRead || false,
			testStructureExplored: state.testStructureExplored || false,
			projectExplored: state.projectExplored || false,
		}
		return JSON.stringify(relevantProps)
	}

	private generateEscalatedGuidance(
		state: any,
		repositoryConfig: RepositoryConfig,
		strategy: FlexibleExplorationStrategy,
	): string {
		const understandingLevel = strategy.determineUnderstandingLevel(state, repositoryConfig)
		const readiness = strategy.assessModificationReadiness(state, repositoryConfig)
		const recommendations = strategy.getExplorationRecommendations(state)

		let guidance = `UNDERSTANDING LEVEL: ${understandingLevel.toUpperCase()}\n\n`

		if (understandingLevel === "insufficient" || understandingLevel === "basic") {
			guidance += `COMPREHENSIVE GUIDANCE NEEDED\n\n`
		} else if (understandingLevel === "comprehensive") {
			guidance += `MINIMAL GUIDANCE\n\n`
		}

		if (this.escalationLevel > 1) {
			guidance += `ESCALATION LEVEL ${this.escalationLevel}\n`
			guidance += `This is your ${this.getOrdinal(this.escalationLevel)} request for guidance with similar state.\n`
			if (this.escalationLevel === 2) {
				guidance += `This is your second request for guidance.\n`
			}
			guidance += `\n`
		}

		if (this.escalationLevel >= 3) {
			guidance += `REPEATED GUIDANCE REQUEST DETECTED\n`
			guidance += `You may be stuck in a loop. Consider trying different approaches.\n\n`
		}

		if (this.escalationLevel >= 5) {
			guidance += `HIGH ESCALATION DETECTED\n`
			guidance += `Consider alternative strategies or asking for human assistance.\n\n`
		}

		// Add understanding-specific guidance
		guidance += `CURRENT STATUS:\n`
		guidance += `- Read calls: ${state.readCallsCount || 0}\n`
		guidance += `- Test calls: ${state.testCallsCount || 0}\n`
		guidance += `- README read: ${state.readmeRead ? "Yes" : "No"}\n`
		guidance += `- Test structure explored: ${state.testStructureExplored ? "Yes" : "No"}\n\n`

		if (!readiness.ready) {
			guidance += `BLOCKING FACTORS:\n`
			readiness.blockingFactors.forEach((factor) => {
				guidance += `- ${factor}\n`
			})
			guidance += `\n`
		}

		if (recommendations.length > 0) {
			guidance += `RECOMMENDED ACTIONS:\n`
			recommendations.slice(0, 3).forEach((rec) => {
				guidance += `- ${rec.action} (${rec.priority} priority)\n`
				guidance += `  Reason: ${rec.reason}\n`
			})
		}

		return guidance
	}

	private getOrdinal(num: number): string {
		const suffixes = ["th", "st", "nd", "rd"]
		const v = num % 100
		return num + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0])
	}
}

/**
 * Factory functions for creating exploration components
 */
export function createFlexibleExplorationStrategy(repositoryType?: string): FlexibleExplorationStrategy {
	if (repositoryType) {
		return new RepositoryAwareExplorationStrategy(repositoryType)
	}
	return new DefaultFlexibleExplorationStrategy()
}

export function createProgressiveGuidanceEscalator(): ProgressiveGuidanceEscalator {
	return new ProgressiveGuidanceEscalator()
}
