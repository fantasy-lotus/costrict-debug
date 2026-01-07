import { describe, it, expect, beforeEach } from "vitest"
import { filterNativeToolsForMode } from "../../prompts/tools/filter-tools-for-mode"
import { getNativeToolsForMode } from "../../prompts/tools/native-tools"
import { getToolDescriptionsForMode } from "../../prompts/tools"
import type OpenAI from "openai"

describe("SWE-bench Tool Filtering", () => {
	let mockTools: OpenAI.Chat.ChatCompletionTool[]

	beforeEach(() => {
		// Create mock tools including update_todo_list
		mockTools = [
			{
				type: "function",
				function: {
					name: "read_file",
					description: "Read a file",
					parameters: { type: "object", properties: {} },
				},
			},
			{
				type: "function",
				function: {
					name: "update_todo_list",
					description: "Update todo list",
					parameters: { type: "object", properties: {} },
				},
			},
			{
				type: "function",
				function: {
					name: "execute_command",
					description: "Execute command",
					parameters: { type: "object", properties: {} },
				},
			},
		]
	})

	it("should exclude update_todo_list in swebench mode", () => {
		const filteredTools = filterNativeToolsForMode(
			mockTools,
			"swebench", // mode
			undefined, // customModes
			{}, // experiments
			undefined, // codeIndexManager
			{ todoListEnabled: true }, // settings
		)

		const toolNames = filteredTools
			.map((tool) => (tool.type === "function" ? tool.function?.name : undefined))
			.filter(Boolean)

		expect(toolNames).not.toContain("update_todo_list")
		expect(toolNames).toContain("read_file")
		expect(toolNames).toContain("execute_command")
	})

	it("should exclude update_todo_list from full native tools pipeline in swebench mode", () => {
		// Test the full pipeline: getNativeToolsForMode -> filterNativeToolsForMode
		const nativeTools = getNativeToolsForMode("swebench", true)
		const filteredTools = filterNativeToolsForMode(
			nativeTools,
			"swebench", // mode
			undefined, // customModes
			{}, // experiments
			undefined, // codeIndexManager
			{ todoListEnabled: true }, // settings
		)

		const toolNames = filteredTools
			.map((tool) => (tool.type === "function" ? tool.function?.name : undefined))
			.filter(Boolean)

		expect(toolNames).not.toContain("update_todo_list")
		// Should contain some basic tools that are allowed in swebench
		expect(toolNames).toContain("read_file")
		expect(toolNames).toContain("execute_command")
		expect(toolNames).toContain("apply_diff")
	})

	it("should exclude update_todo_list from tool descriptions in swebench mode", () => {
		const toolDescriptions = getToolDescriptionsForMode(
			"swebench", // mode
			"/test/cwd", // cwd
			false, // supportsComputerUse
			undefined, // codeIndexManager
			undefined, // diffStrategy
			undefined, // browserViewportSize
			undefined, // mcpHub
			undefined, // customModes
			{}, // experiments
			true, // partialReadsEnabled
			{ todoListEnabled: true }, // settings
		)

		// Should not contain update_todo_list description
		expect(toolDescriptions).not.toContain("update_todo_list")

		// Should contain other allowed tools
		expect(toolDescriptions).toContain("read_file")
		expect(toolDescriptions).toContain("execute_command")
	})
})
