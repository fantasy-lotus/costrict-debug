import { describe, it, expect, beforeEach } from "vitest"
import {
	DefaultFlexibleExplorationStrategy,
	ProgressiveGuidanceEscalator,
	createFlexibleExplorationStrategy,
	createProgressiveGuidanceEscalator,
} from "../flexible-exploration"
import { createInitialState } from "../state-machine"
import { getRepositoryConfig } from "../repository-config"

describe("Flexible Exploration System", () => {
	let strategy: DefaultFlexibleExplorationStrategy
	let escalator: ProgressiveGuidanceEscalator
	let repositoryConfig: ReturnType<typeof getRepositoryConfig>

	beforeEach(() => {
		strategy = new DefaultFlexibleExplorationStrategy()
		escalator = new ProgressiveGuidanceEscalator()
		repositoryConfig = getRepositoryConfig("")
	})

	describe("DefaultFlexibleExplorationStrategy", () => {
		describe("getExplorationRecommendations", () => {
			it("should recommend README reading for fresh state", () => {
				const state = createInitialState()
				const recommendations = strategy.getExplorationRecommendations(state)

				const readmeRec = recommendations.find((r) => r.action.includes("README"))
				expect(readmeRec).toBeDefined()
				expect(readmeRec?.priority).toBe("high")
			})

			it("should recommend test structure exploration", () => {
				const state = { ...createInitialState(), readmeRead: true }
				const recommendations = strategy.getExplorationRecommendations(state)

				const testStructureRec = recommendations.find((r) => r.action.includes("test directory"))
				expect(testStructureRec).toBeDefined()
				expect(testStructureRec?.priority).toBe("high")
			})

			it("should recommend test execution after sufficient reading", () => {
				const state = {
					...createInitialState(),
					readCallsCount: 6,
					testCallsCount: 0,
					readmeRead: true,
					testStructureExplored: true,
				}
				const recommendations = strategy.getExplorationRecommendations(state)

				const testExecRec = recommendations.find((r) => r.action.includes("Execute test"))
				expect(testExecRec).toBeDefined()
				expect(testExecRec?.priority).toBe("critical")
			})

			it("should recommend more reading for insufficient exploration", () => {
				const state = { ...createInitialState(), readCallsCount: 2 }
				const recommendations = strategy.getExplorationRecommendations(state)

				const moreReadingRec = recommendations.find((r) => r.action.includes("Read more source"))
				expect(moreReadingRec).toBeDefined()
				expect(moreReadingRec?.priority).toBe("medium")
			})
		})

		describe("assessModificationReadiness", () => {
			it("should block modifications with insufficient understanding", () => {
				const state = { ...createInitialState(), readCallsCount: 5, testCallsCount: 0 }
				const readiness = strategy.assessModificationReadiness(state, repositoryConfig)

				expect(readiness.ready).toBe(false)
				expect(readiness.blockingFactors.length).toBeGreaterThan(0)
				expect(readiness.blockingFactors.some((f) => f.includes("No test execution"))).toBe(true)
				expect(readiness.recommendations.length).toBeGreaterThan(0)
			})

			it("should allow modifications with sufficient understanding", () => {
				const state = {
					...createInitialState(),
					readCallsCount: 12,
					testCallsCount: 2,
					readmeRead: true,
					testStructureExplored: true,
				}
				const readiness = strategy.assessModificationReadiness(state, repositoryConfig)

				expect(readiness.ready).toBe(true)
				expect(readiness.blockingFactors).toHaveLength(0)
			})

			it("should provide progressive recommendations", () => {
				const state = { ...createInitialState(), readCallsCount: 8, testCallsCount: 0 }
				const readiness = strategy.assessModificationReadiness(state, repositoryConfig)

				expect(readiness.recommendations.length).toBeGreaterThan(0)
				expect(readiness.recommendations.some((r) => r.includes("Execute tests"))).toBe(true)
			})
		})

		describe("determineUnderstandingLevel", () => {
			it("should classify insufficient understanding", () => {
				const state = { ...createInitialState(), readCallsCount: 2, testCallsCount: 0 }
				const level = strategy.determineUnderstandingLevel(state, repositoryConfig)

				expect(level).toBe("insufficient")
			})

			it("should classify basic understanding", () => {
				const state = {
					...createInitialState(),
					readCallsCount: 6,
					testCallsCount: 0,
					readmeRead: true,
				}
				const level = strategy.determineUnderstandingLevel(state, repositoryConfig)

				expect(level).toBe("basic")
			})

			it("should classify adequate understanding", () => {
				const state = {
					...createInitialState(),
					readCallsCount: 12,
					testCallsCount: 1,
					readmeRead: true,
					testStructureExplored: true,
				}
				const level = strategy.determineUnderstandingLevel(state, repositoryConfig)

				expect(level).toBe("adequate")
			})

			it("should classify comprehensive understanding", () => {
				const state = {
					...createInitialState(),
					readCallsCount: 25,
					testCallsCount: 3,
					readmeRead: true,
					testStructureExplored: true,
					projectExplored: true,
				}
				const level = strategy.determineUnderstandingLevel(state, repositoryConfig)

				expect(level).toBe("comprehensive")
			})
		})

		describe("getGuidanceLevel", () => {
			it("should provide comprehensive guidance for insufficient understanding", () => {
				const intensity = strategy.getGuidanceLevel("insufficient")
				expect(intensity).toBe("comprehensive")
			})

			it("should provide minimal guidance for comprehensive understanding", () => {
				const intensity = strategy.getGuidanceLevel("comprehensive")
				expect(intensity).toBe("minimal")
			})
		})
	})

	describe("ProgressiveGuidanceEscalator", () => {
		it("should provide base guidance on first request", () => {
			const state = { ...createInitialState(), readCallsCount: 3 }
			const guidance = escalator.getEscalatedGuidance(state, repositoryConfig, strategy)

			expect(guidance).toContain("UNDERSTANDING LEVEL")
			expect(guidance).toContain("COMPREHENSIVE GUIDANCE NEEDED")
			expect(guidance).not.toContain("ESCALATION LEVEL")
		})

		it("should escalate guidance on repeated requests", () => {
			const state = { ...createInitialState(), readCallsCount: 3 }

			// First request
			escalator.getEscalatedGuidance(state, repositoryConfig, strategy)

			// Second request (should escalate)
			const guidance = escalator.getEscalatedGuidance(state, repositoryConfig, strategy)

			expect(guidance).toContain("ESCALATION LEVEL 2")
			expect(guidance).toContain("second request for guidance")
		})

		it("should provide stronger escalation for repeated loops", () => {
			const state = { ...createInitialState(), readCallsCount: 3 }

			// Multiple requests
			escalator.getEscalatedGuidance(state, repositoryConfig, strategy)
			escalator.getEscalatedGuidance(state, repositoryConfig, strategy)
			const guidance = escalator.getEscalatedGuidance(state, repositoryConfig, strategy)

			expect(guidance).toContain("ESCALATION LEVEL 3")
			expect(guidance).toContain("REPEATED GUIDANCE REQUEST DETECTED")
		})

		it("should provide high escalation warnings", () => {
			const state = { ...createInitialState(), readCallsCount: 3 }

			// Many requests
			for (let i = 0; i < 4; i++) {
				escalator.getEscalatedGuidance(state, repositoryConfig, strategy)
			}

			const guidance = escalator.getEscalatedGuidance(state, repositoryConfig, strategy)

			expect(guidance).toContain("HIGH ESCALATION DETECTED")
			expect(guidance).toContain("alternative strategies")
		})

		it("should reset escalation history", () => {
			const state = { ...createInitialState(), readCallsCount: 3 }

			// Create escalation
			escalator.getEscalatedGuidance(state, repositoryConfig, strategy)
			escalator.getEscalatedGuidance(state, repositoryConfig, strategy)

			// Reset
			escalator.reset()

			// Should not show escalation
			const guidance = escalator.getEscalatedGuidance(state, repositoryConfig, strategy)
			expect(guidance).not.toContain("ESCALATION LEVEL")
		})
	})

	describe("Factory Functions", () => {
		it("should create flexible exploration strategy", () => {
			const strategy = createFlexibleExplorationStrategy()
			expect(strategy).toBeInstanceOf(DefaultFlexibleExplorationStrategy)
		})

		it("should create progressive guidance escalator", () => {
			const escalator = createProgressiveGuidanceEscalator()
			expect(escalator).toBeInstanceOf(ProgressiveGuidanceEscalator)
		})
	})

	describe("Integration with Understanding Levels", () => {
		it("should provide different recommendations for different understanding levels", () => {
			const insufficientState = { ...createInitialState(), readCallsCount: 2 }
			const basicState = { ...createInitialState(), readCallsCount: 6, readmeRead: true }

			const insufficientRecs = strategy.getExplorationRecommendations(insufficientState)
			const basicRecs = strategy.getExplorationRecommendations(basicState)

			expect(insufficientRecs.length).toBeGreaterThan(0)
			expect(basicRecs.length).toBeGreaterThan(0)

			// Should have different recommendations
			const insufficientActions = insufficientRecs.map((r) => r.action)
			const basicActions = basicRecs.map((r) => r.action)
			expect(insufficientActions).not.toEqual(basicActions)
		})

		it("should escalate guidance intensity based on understanding level", () => {
			const insufficientState = { ...createInitialState(), readCallsCount: 2 }
			const comprehensiveState = {
				...createInitialState(),
				readCallsCount: 25,
				testCallsCount: 3,
				projectExplored: true,
			}

			const insufficientGuidance = escalator.getEscalatedGuidance(insufficientState, repositoryConfig, strategy)
			const comprehensiveGuidance = escalator.getEscalatedGuidance(comprehensiveState, repositoryConfig, strategy)

			expect(insufficientGuidance).toContain("COMPREHENSIVE GUIDANCE NEEDED")
			expect(comprehensiveGuidance).toContain("MINIMAL GUIDANCE")
		})
	})
})
