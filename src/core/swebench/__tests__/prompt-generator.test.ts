/**
 * Tests for SWE-bench Prompt Generator
 */

import { describe, it, expect } from "vitest"
import { SWEBenchPromptGenerator, TemplateEngine, createPromptGenerator } from "../prompt-generator"
import { createInitialState } from "../state-machine"
import { getRepositoryConfig } from "../repository-config"

describe("TemplateEngine", () => {
	const engine = new TemplateEngine()

	it("should substitute simple variables", () => {
		const template = {
			id: "test",
			content: "Hello {{name}}, you have {{count}} messages",
			requiredVariables: ["name", "count"],
		}

		const result = engine.render(template, { name: "Alice", count: 5 })
		expect(result).toBe("Hello Alice, you have 5 messages")
	})

	it("should handle conditional blocks", () => {
		const template = {
			id: "test",
			content: "{{#if hasMessages}}You have messages{{else}}No messages{{/if}}",
			requiredVariables: [],
		}

		const resultTrue = engine.render(template, { hasMessages: true })
		expect(resultTrue).toBe("You have messages")

		const resultFalse = engine.render(template, { hasMessages: false })
		expect(resultFalse).toBe("No messages")
	})

	it("should handle simple if blocks", () => {
		const template = {
			id: "test",
			content: "{{#if show}}This is shown{{/if}}",
			requiredVariables: [],
		}

		const resultTrue = engine.render(template, { show: true })
		expect(resultTrue).toBe("This is shown")

		const resultFalse = engine.render(template, { show: false })
		expect(resultFalse).toBe("")
	})
})

describe("SWEBenchPromptGenerator", () => {
	it("should generate ANALYZE phase guidance", () => {
		const generator = createPromptGenerator()
		const state = createInitialState()
		const repositoryConfig = getRepositoryConfig("")

		const context = {
			state,
			repositoryConfig,
			instanceId: undefined,
		}

		const result = generator.generatePhaseGuidance(context)

		expect(result.content).toContain("CURRENT PHASE: ANALYZE")
		expect(result.content).toContain("SWE-BENCH TASK OBJECTIVE")
		expect(result.content).toContain("❌ Tests not yet run")
		expect(result.templateId).toBe("analyze-default")
	})

	it("should show different content after tests are run", () => {
		const generator = createPromptGenerator()
		const state = {
			...createInitialState(),
			hasRunTests: true,
			testsRunCount: 1,
		}

		const repositoryConfig = getRepositoryConfig("")

		const context = {
			state,
			repositoryConfig,
			instanceId: undefined,
		}

		const result = generator.generatePhaseGuidance(context)

		expect(result.content).toContain("✅ Tests run (1 times)")
		expect(result.content).not.toContain("❌ Tests not yet run")
	})
})
