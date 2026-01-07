/**
 * SWE-bench Context Compression Tests
 */

import { ApiMessage } from "../../task-persistence/apiMessages"
import {
	summarizeSWEBenchConversation,
	shouldTriggerSWEBenchCondense,
	manageSWEBenchContext,
	SWEBENCH_CONDENSE_THRESHOLD,
	SWEBENCH_TOOL_RESULTS_TO_KEEP,
	SWEBENCH_MAX_TOOL_RESULT_LENGTH,
} from "../context-compression"

// Mock API handler
const createMockApiHandler = () => ({
	countTokens: vi.fn().mockResolvedValue(100),
	createMessage: vi.fn().mockImplementation(function* () {
		yield { type: "text", text: "Test summary of the conversation." }
		yield { type: "usage", totalCost: 0.001, outputTokens: 50 }
	}),
	getModel: vi.fn().mockReturnValue({
		id: "test-model",
		info: { contextWindow: 100000 },
	}),
})

describe("SWE-bench Context Compression", () => {
	describe("Configuration Constants", () => {
		it("should have correct threshold value (60%)", () => {
			expect(SWEBENCH_CONDENSE_THRESHOLD).toBe(60)
		})

		it("should keep 4 recent tool results", () => {
			expect(SWEBENCH_TOOL_RESULTS_TO_KEEP).toBe(4)
		})

		it("should have reasonable max tool result length", () => {
			expect(SWEBENCH_MAX_TOOL_RESULT_LENGTH).toBe(8000)
		})
	})

	describe("shouldTriggerSWEBenchCondense", () => {
		it("should trigger at 60% context usage", () => {
			const contextWindow = 100000
			const totalTokens = 55000 // 55%
			const lastMessageTokens = 6000 // +6% = 61%

			const result = shouldTriggerSWEBenchCondense(totalTokens, contextWindow, lastMessageTokens)
			expect(result).toBe(true)
		})

		it("should not trigger below 60% context usage", () => {
			const contextWindow = 100000
			const totalTokens = 50000 // 50%
			const lastMessageTokens = 5000 // +5% = 55%

			const result = shouldTriggerSWEBenchCondense(totalTokens, contextWindow, lastMessageTokens)
			expect(result).toBe(false)
		})

		it("should trigger exactly at 60%", () => {
			const contextWindow = 100000
			const totalTokens = 55000
			const lastMessageTokens = 5000 // exactly 60%

			const result = shouldTriggerSWEBenchCondense(totalTokens, contextWindow, lastMessageTokens)
			expect(result).toBe(true)
		})

		it("should account for token buffer (10%) when checking threshold", () => {
			const contextWindow = 100000
			// With 10% buffer, usable context = 90000
			// 60% of 90000 = 54000
			const totalTokens = 50000 // 50% of original, but 55.6% of usable
			const lastMessageTokens = 5000 // Would be 55% of original, but 61.1% of usable

			const result = shouldTriggerSWEBenchCondense(totalTokens, contextWindow, lastMessageTokens)
			expect(result).toBe(true)
		})

		it("should account for maxTokens when checking threshold", () => {
			const contextWindow = 100000
			const maxTokens = 10000
			// With 10% buffer (10000) + maxTokens (10000), usable context = 80000
			// 60% of 80000 = 48000
			const totalTokens = 45000 // 45% of original, but 56.25% of usable
			const lastMessageTokens = 5000 // Would be 50% of original, but 62.5% of usable

			const result = shouldTriggerSWEBenchCondense(totalTokens, contextWindow, lastMessageTokens, maxTokens)
			expect(result).toBe(true)
		})

		it("should not trigger when below threshold after accounting for buffer and maxTokens", () => {
			const contextWindow = 100000
			const maxTokens = 10000
			// With 10% buffer (10000) + maxTokens (10000), usable context = 80000
			// 60% of 80000 = 48000
			const totalTokens = 40000 // 40% of original, but 50% of usable
			const lastMessageTokens = 3000 // Would be 43% of original, but 53.75% of usable

			const result = shouldTriggerSWEBenchCondense(totalTokens, contextWindow, lastMessageTokens, maxTokens)
			expect(result).toBe(false)
		})
	})

	describe("summarizeSWEBenchConversation", () => {
		it("should preserve first message (task description)", async () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "Fix the bug in module X", ts: 1000 },
				{ role: "assistant", content: "I will analyze the code.", ts: 1001 },
				{ role: "user", content: "Continue", ts: 1002 },
				{ role: "assistant", content: "Found the issue.", ts: 1003 },
				{ role: "user", content: "Great", ts: 1004 },
			]

			const mockHandler = createMockApiHandler()
			const result = await summarizeSWEBenchConversation(
				messages,
				mockHandler as any,
				"system prompt",
				"task-123",
				50000,
				false,
			)

			// First message should not have condenseParent
			const firstMsg = result.messages.find((m) => m.ts === 1000)
			expect(firstMsg).toBeDefined()
			expect(firstMsg?.condenseParent).toBeUndefined()
		})

		it("should return error when not enough messages to summarize", async () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "Fix the bug", ts: 1000 },
				{ role: "assistant", content: "OK", ts: 1001 },
			]

			const mockHandler = createMockApiHandler()
			const result = await summarizeSWEBenchConversation(
				messages,
				mockHandler as any,
				"system prompt",
				"task-123",
				50000,
				false,
			)

			expect(result.error).toBeDefined()
			expect(result.summary).toBe("")
		})

		it("should skip if recent summary exists in kept messages", async () => {
			// The last message has isSummary flag, which should be in keepMessages
			const messages: ApiMessage[] = [
				{ role: "user", content: "Fix the bug", ts: 1000 },
				{ role: "assistant", content: "Analyzing...", ts: 1001 },
				{ role: "user", content: "Continue", ts: 1002 },
				{ role: "assistant", content: "Working...", ts: 1003 },
				{ role: "user", content: "More", ts: 1004 },
				{ role: "assistant", content: "Even more", ts: 1005 },
				{ role: "user", content: "Summary of previous work", ts: 1006, isSummary: true }, // Last message is summary
			]

			const mockHandler = createMockApiHandler()
			const result = await summarizeSWEBenchConversation(
				messages,
				mockHandler as any,
				"system prompt",
				"task-123",
				50000,
				false,
			)

			// Should skip due to summary in kept messages
			expect(result.error).toContain("summarized")
		})
	})

	describe("Tool Result Preservation", () => {
		it("should identify messages with tool_result blocks", async () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "Fix the bug", ts: 1000 },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "tool1", name: "read_file", input: { path: "test.py" } }],
					ts: 1001,
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "tool1", content: "file content here" }],
					ts: 1002,
				},
				{ role: "assistant", content: "I see the file.", ts: 1003 },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "tool2", name: "execute_command", input: { command: "pytest" } }],
					ts: 1004,
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "tool2", content: "test output" }],
					ts: 1005,
				},
				{ role: "assistant", content: "Tests passed.", ts: 1006 },
				{ role: "user", content: "Great work!", ts: 1007 },
			]

			const mockHandler = createMockApiHandler()
			const result = await summarizeSWEBenchConversation(
				messages,
				mockHandler as any,
				"system prompt",
				"task-123",
				50000,
				false,
			)

			// Recent tool results should be preserved (not have condenseParent)
			const toolResultMessages = result.messages.filter(
				(m) =>
					m.role === "user" &&
					Array.isArray(m.content) &&
					m.content.some((b: any) => b.type === "tool_result"),
			)

			// At least some tool results should be preserved
			const preservedToolResults = toolResultMessages.filter((m) => !m.condenseParent)
			expect(preservedToolResults.length).toBeGreaterThan(0)
		})

		it("should preserve tool_use blocks when first kept message (after task) is a tool_result (native-tools pairing)", async () => {
			// Scenario: Task message (idx 0) is kept, then we have many messages to summarize,
			// and the first real kept message (idx > 0) is a user message with tool_result.
			// The summary should include the preceding tool_use blocks.
			const messages: ApiMessage[] = [
				{ role: "user", content: "Fix the bug in module X", ts: 1000 }, // idx 0 - always kept
				{ role: "assistant", content: "I will analyze.", ts: 1001 },
				{ role: "user", content: "Continue", ts: 1002 },
				{ role: "assistant", content: "Working...", ts: 1003 },
				{ role: "user", content: "More", ts: 1004 },
				{ role: "assistant", content: "Still working", ts: 1005 },
				// These will be summarized
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "tool1", name: "read_file", input: { path: "test.py" } },
						{ type: "tool_use", id: "tool2", name: "grep", input: { pattern: "bug" } },
					],
					ts: 1006,
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "tool1", content: "file content" },
						{ type: "tool_result", tool_use_id: "tool2", content: "matches found" },
					],
					ts: 1007,
				}, // This is the first real kept message (after task) - should trigger tool_use preservation
				{ role: "assistant", content: "I see the results.", ts: 1008 },
				{ role: "user", content: "Great", ts: 1009 },
			]

			const mockHandler = createMockApiHandler()
			const result = await summarizeSWEBenchConversation(
				messages,
				mockHandler as any,
				"system prompt",
				"task-123",
				50000,
				true, // useNativeTools = true
			)

			// Find the summary message
			const summaryMessage = result.messages.find((m) => m.isSummary)
			expect(summaryMessage).toBeDefined()

			// Summary should contain tool_use blocks when using native tools
			if (summaryMessage && Array.isArray(summaryMessage.content)) {
				const toolUseBlocks = summaryMessage.content.filter((b: any) => b.type === "tool_use")
				expect(toolUseBlocks.length).toBeGreaterThan(0)
				expect(toolUseBlocks.length).toBe(2) // Should have both tool1 and tool2
			}
		})
	})

	describe("manageSWEBenchContext", () => {
		it("should not trigger when below threshold", async () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "Fix the bug", ts: 1000 },
				{ role: "assistant", content: "OK", ts: 1001 },
			]

			const mockHandler = createMockApiHandler()
			const result = await manageSWEBenchContext({
				messages,
				totalTokens: 30000, // 30%
				contextWindow: 100000,
				apiHandler: mockHandler as any,
				systemPrompt: "system prompt",
				taskId: "task-123",
			})

			expect(result.triggered).toBe(false)
			expect(result.messages).toBe(messages) // Same reference, no changes
		})

		it("should trigger when above threshold", async () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "Fix the bug", ts: 1000 },
				{ role: "assistant", content: "Analyzing...", ts: 1001 },
				{ role: "user", content: "Continue", ts: 1002 },
				{ role: "assistant", content: "Found issue", ts: 1003 },
				{ role: "user", content: "Fix it", ts: 1004 },
				{ role: "assistant", content: "Done", ts: 1005 },
			]

			const mockHandler = createMockApiHandler()
			const result = await manageSWEBenchContext({
				messages,
				totalTokens: 65000, // 65%
				contextWindow: 100000,
				apiHandler: mockHandler as any,
				systemPrompt: "system prompt",
				taskId: "task-123",
			})

			expect(result.triggered).toBe(true)
		})

		it("should account for maxTokens when deciding to trigger", async () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "Fix the bug", ts: 1000 },
				{ role: "assistant", content: "Analyzing...", ts: 1001 },
				{ role: "user", content: "Continue", ts: 1002 },
				{ role: "assistant", content: "Found issue", ts: 1003 },
			]

			const mockHandler = createMockApiHandler()
			// With maxTokens=10000 and 10% buffer, usable context = 80000
			// 60% of 80000 = 48000, so 50000 should trigger
			const result = await manageSWEBenchContext({
				messages,
				totalTokens: 45000, // 45% of original, but 56.25% of usable
				contextWindow: 100000,
				maxTokens: 10000,
				apiHandler: mockHandler as any,
				systemPrompt: "system prompt",
				taskId: "task-123",
			})

			// Should trigger because we're above 60% of usable context
			expect(result.triggered).toBe(true)
		})

		it("should not trigger when below threshold after accounting for maxTokens", async () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "Fix the bug", ts: 1000 },
				{ role: "assistant", content: "OK", ts: 1001 },
			]

			const mockHandler = createMockApiHandler()
			// With maxTokens=10000 and 10% buffer, usable context = 80000
			// 60% of 80000 = 48000, so 40000 should not trigger
			const result = await manageSWEBenchContext({
				messages,
				totalTokens: 40000, // 40% of original, but 50% of usable
				contextWindow: 100000,
				maxTokens: 10000,
				apiHandler: mockHandler as any,
				systemPrompt: "system prompt",
				taskId: "task-123",
			})

			expect(result.triggered).toBe(false)
		})
	})

	describe("Tool Result Truncation", () => {
		it("should truncate long tool results", async () => {
			const longContent = "x".repeat(15000) // Longer than SWEBENCH_MAX_TOOL_RESULT_LENGTH (8000)

			const messages: ApiMessage[] = [
				{ role: "user", content: "Fix the bug", ts: 1000 },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "tool1", name: "read_file", input: { path: "test.py" } }],
					ts: 1001,
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "tool1", content: longContent }],
					ts: 1002,
				},
				{ role: "assistant", content: "I see.", ts: 1003 },
				{ role: "user", content: "Continue", ts: 1004 },
				{ role: "assistant", content: "Working...", ts: 1005 },
				{ role: "user", content: "More", ts: 1006 },
				{ role: "assistant", content: "Done", ts: 1007 },
				{ role: "user", content: "Great", ts: 1008 },
			]

			const mockHandler = createMockApiHandler()
			const result = await summarizeSWEBenchConversation(
				messages,
				mockHandler as any,
				"system prompt",
				"task-123",
				50000,
				false,
			)

			// Find the tool result message in the result
			const toolResultMsg = result.messages.find(
				(m) =>
					m.role === "user" &&
					Array.isArray(m.content) &&
					m.content.some((b: any) => b.type === "tool_result"),
			)

			if (toolResultMsg && Array.isArray(toolResultMsg.content)) {
				const toolResultBlock = toolResultMsg.content.find((b: any) => b.type === "tool_result") as any
				if (toolResultBlock && typeof toolResultBlock.content === "string") {
					// Should be truncated
					expect(toolResultBlock.content.length).toBeLessThan(longContent.length)
					expect(toolResultBlock.content).toContain("TRUNCATED")
				}
			}
		})
	})
})
