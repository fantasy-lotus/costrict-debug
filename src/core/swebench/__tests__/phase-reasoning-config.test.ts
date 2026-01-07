// npx vitest run src/core/swebench/__tests__/phase-reasoning-config.test.ts

import { describe, it, expect, beforeEach } from "vitest"
import { SWEBenchStateMachine, PHASE_CONFIGS } from "../state-machine"
import { SWEBenchToolInterceptor } from "../tool-interceptor"

describe("SWE-bench Phase Reasoning Configuration", () => {
	let stateMachine: SWEBenchStateMachine
	let interceptor: SWEBenchToolInterceptor

	beforeEach(() => {
		stateMachine = new SWEBenchStateMachine()
		interceptor = new SWEBenchToolInterceptor({ strictMode: true })
	})

	describe("Phase-specific reasoning configurations", () => {
		it("should have correct reasoning config for ANALYZE phase", () => {
			const analyzeConfig = PHASE_CONFIGS.ANALYZE.reasoningConfig
			expect(analyzeConfig).toBeDefined()
			expect(analyzeConfig?.reasoningEffort).toBe("high")
			// PHASE_CONFIGS stores the max budget for the phase (dynamic scaling is applied in currentReasoningConfig)
			expect(analyzeConfig?.reasoningBudget).toBe(16384)
		})

		it("should have correct reasoning config for MODIFY phase", () => {
			const modifyConfig = PHASE_CONFIGS.MODIFY.reasoningConfig
			expect(modifyConfig).toBeDefined()
			expect(modifyConfig?.reasoningEffort).toBe("medium")
			expect(modifyConfig?.reasoningBudget).toBe(8192)
		})

		it("should have correct reasoning config for VERIFY phase", () => {
			const verifyConfig = PHASE_CONFIGS.VERIFY.reasoningConfig
			expect(verifyConfig).toBeDefined()
			expect(verifyConfig?.reasoningEffort).toBe("low")
			expect(verifyConfig?.reasoningBudget).toBe(16384)
		})

		// COMPLETE phase removed - completion happens in VERIFY phase
	})

	describe("State machine reasoning config updates", () => {
		it("should start with ANALYZE phase reasoning config", () => {
			const initialConfig = stateMachine.getCurrentReasoningConfig()
			expect(initialConfig).toEqual({
				reasoningEffort: "high",
				// Initial budget is dynamically scaled to 0.5 of max (16384 -> 8192)
				reasoningBudget: 8192,
			})
		})

		it("should update reasoning config when transitioning to MODIFY phase", () => {
			// Simulate test execution to transition to MODIFY phase
			stateMachine.recordToolUse("execute_command", { command: "pytest tests/" }, "FAILED: 2 failed, 3 passed")

			const config = stateMachine.getCurrentReasoningConfig()
			expect(config).toEqual({
				reasoningEffort: "medium",
				// MODIFY max=8192, scaled 0.5 at low toolCallsCount => 4096
				reasoningBudget: 4096,
			})
			expect(stateMachine.getPhase()).toBe("MODIFY")
		})

		it("should update reasoning config when transitioning to VERIFY phase", () => {
			// Move to MODIFY phase first
			stateMachine.recordToolUse("execute_command", { command: "pytest tests/" }, "FAILED: 2 failed, 3 passed")

			// Apply a modification (still in MODIFY)
			stateMachine.recordToolUse("apply_diff", { path: "src/models.py" }, "Applied diff successfully")

			// VERIFY transition happens after 5 execute_command calls after modifications
			for (let i = 0; i < 5; i++) {
				stateMachine.recordToolUse("execute_command", { command: "pytest tests/" }, "PASSED: 5 passed")
			}

			const config = stateMachine.getCurrentReasoningConfig()
			expect(config).toEqual({
				reasoningEffort: "low",
				// VERIFY max=16384, scaled 0.5 at low toolCallsCount => 8192
				reasoningBudget: 8192,
			})
			expect(stateMachine.getPhase()).toBe("VERIFY")
		})

		it("should stay in VERIFY phase after running tests", () => {
			// Move through all phases
			stateMachine.recordToolUse("execute_command", { command: "pytest tests/" }, "FAILED: 2 failed, 3 passed")
			stateMachine.recordToolUse("apply_diff", { path: "src/models.py" }, "Applied diff successfully")
			for (let i = 0; i < 5; i++) {
				stateMachine.recordToolUse("execute_command", { command: "pytest tests/" }, "PASSED: 5 passed")
			}

			const config = stateMachine.getCurrentReasoningConfig()
			expect(config).toEqual({
				reasoningEffort: "low",
				reasoningBudget: 8192,
			})
			expect(stateMachine.getPhase()).toBe("VERIFY")
		})

		it("should increase reasoning budget after 50 tool calls", () => {
			// Each tool use increments the internal toolCallsCount.
			for (let i = 0; i < 50; i++) {
				stateMachine.recordToolUse("read_file", { path: "README.md" }, "")
			}

			const config = stateMachine.getCurrentReasoningConfig()
			expect(config).toEqual({
				reasoningEffort: "high",
				// After 50 tool calls, scaling reaches 1.0 (max budget)
				reasoningBudget: 16384,
			})
		})

		it("should surface an extra guidance note at the 50th tool call", () => {
			// The interceptor returns guidance which is appended to the tool result.
			let guidance: string | null = null
			for (let i = 0; i < 49; i++) {
				guidance = interceptor.recordToolExecution("read_file", { path: `README-${i}.md` }, "content")
				expect(guidance).toBeNull()
			}

			guidance = interceptor.recordToolExecution("read_file", { path: "README-49.md" }, "content")
			expect(guidance).toContain("Reasoning budget increased")
			expect(guidance).toContain("sequential-thinking")
		})
	})

	describe("Interceptor reasoning config access", () => {
		it("should provide access to current reasoning config", () => {
			const config = interceptor.getCurrentReasoningConfig()
			expect(config).toEqual({
				reasoningEffort: "high",
				reasoningBudget: 8192,
			})
		})

		it("should update reasoning config through interceptor", () => {
			// Simulate test execution through interceptor
			interceptor.recordToolExecution(
				"execute_command",
				{ command: "pytest tests/" },
				"FAILED: 2 failed, 3 passed",
			)

			const config = interceptor.getCurrentReasoningConfig()
			expect(config).toEqual({
				reasoningEffort: "medium",
				reasoningBudget: 4096,
			})
		})
	})

	describe("Force phase transitions", () => {
		it("should update reasoning config when forcing phase transition", () => {
			stateMachine.forcePhase("VERIFY")

			const config = stateMachine.getCurrentReasoningConfig()
			expect(config).toEqual({
				reasoningEffort: "low",
				reasoningBudget: 8192,
			})
			expect(stateMachine.getPhase()).toBe("VERIFY")
		})
	})

	describe("State serialization and restoration", () => {
		it("should preserve reasoning config when serializing and deserializing", () => {
			// Move to MODIFY phase
			stateMachine.recordToolUse("execute_command", { command: "pytest tests/" }, "FAILED: 2 failed, 3 passed")

			// Serialize state
			const serialized = stateMachine.serialize()

			// Create new state machine and restore
			const newStateMachine = SWEBenchStateMachine.deserialize(serialized)

			const config = newStateMachine.getCurrentReasoningConfig()
			expect(config).toEqual({
				reasoningEffort: "medium",
				reasoningBudget: 4096,
			})
			expect(newStateMachine.getPhase()).toBe("MODIFY")
		})
	})

	describe("Integration with phase guidance", () => {
		it("should include reasoning config information in phase guidance", () => {
			const guidance = stateMachine.getPhaseGuidance()

			// Should mention the current phase and its characteristics
			expect(guidance).toContain("ANALYZE")
			expect(guidance).toContain("Understand the issue")
		})

		it("should update guidance when phase changes", () => {
			// Move to MODIFY phase
			stateMachine.recordToolUse("execute_command", { command: "pytest tests/" }, "FAILED: 2 failed, 3 passed")

			const guidance = stateMachine.getPhaseGuidance()
			expect(guidance).toContain("MODIFY")
			expect(guidance).toContain("code changes")
		})
	})
})
