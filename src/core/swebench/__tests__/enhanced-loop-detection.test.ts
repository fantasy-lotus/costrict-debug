// npx vitest run src/core/swebench/__tests__/enhanced-loop-detection.test.ts

import { describe, it, expect, beforeEach } from "vitest"
import { SWEBenchToolInterceptor } from "../tool-interceptor"

describe("Enhanced Loop Detection", () => {
	let interceptor: SWEBenchToolInterceptor

	beforeEach(() => {
		interceptor = new SWEBenchToolInterceptor({ strictMode: true })
	})

	describe("Basic loop detection", () => {
		it("should detect repeated failed search operations", () => {
			const params = { regex: "test_example", file_pattern: "*.py" }

			// Simulate 3 failed searches
			interceptor.recordToolExecution("search_files", params, "Found 0 results")
			interceptor.recordToolExecution("search_files", params, "Found 0 results")
			interceptor.recordToolExecution("search_files", params, "Found 0 results")

			// 4th attempt should be blocked
			const result = interceptor.validateToolUse("search_files", params)
			expect(result).toContain("🔄 LOOP DETECTED")
			expect(result).toContain("attempted the same operation")
		})

		it("should detect repeated failed command executions", () => {
			// Complete project exploration first to avoid blocking
			interceptor.recordToolExecution("read_file", { path: "README.md" }, "Project README")
			interceptor.recordToolExecution("list_files", { path: "tests" }, "test files")

			const params = { command: "pytest tests/test_example.py::TestClass::test_method" }

			// Simulate 3 failed test runs
			interceptor.recordToolExecution(
				"execute_command",
				params,
				"AttributeError: module has no attribute 'test_method'",
			)
			interceptor.recordToolExecution(
				"execute_command",
				params,
				"AttributeError: module has no attribute 'test_method'",
			)
			interceptor.recordToolExecution(
				"execute_command",
				params,
				"AttributeError: module has no attribute 'test_method'",
			)

			// 4th attempt should be blocked
			const result = interceptor.validateToolUse("execute_command", params)
			expect(result).toContain("🔄 LOOP DETECTED")
		})

		it("should not block if operations succeed", () => {
			const params = { regex: "test_example", file_pattern: "*.py" }

			// Simulate successful searches
			interceptor.recordToolExecution("search_files", params, "Found 5 results in test_example.py")
			interceptor.recordToolExecution("search_files", params, "Found 5 results in test_example.py")
			interceptor.recordToolExecution("search_files", params, "Found 5 results in test_example.py")

			const result = interceptor.validateToolUse("search_files", params)
			expect(result).toBeNull()
		})

		it("should reset counter when different operation is performed", () => {
			const searchParams = { regex: "test_example", file_pattern: "*.py" }
			const readParams = { path: "test_example.py" }

			// Simulate 2 failed searches
			interceptor.recordToolExecution("search_files", searchParams, "Found 0 results")
			interceptor.recordToolExecution("search_files", searchParams, "Found 0 results")

			// Different operation (successful) - this breaks the consecutive failure chain
			interceptor.recordToolExecution("read_file", readParams, "file content")

			// Back to search - should start fresh counter since consecutive chain was broken
			interceptor.recordToolExecution("search_files", searchParams, "Found 0 results")
			interceptor.recordToolExecution("search_files", searchParams, "Found 0 results")

			// Should not be blocked yet (only 2 consecutive failures after the break)
			const result = interceptor.validateToolUse("search_files", searchParams)
			expect(result).toBeNull()
		})
	})

	describe("Escalating loop detection", () => {
		it("should escalate warning on repeated loop detection", () => {
			const params1 = { regex: "test_example", file_pattern: "*.py" }

			// First loop
			for (let i = 0; i < 3; i++) {
				interceptor.recordToolExecution("search_files", params1, "Found 0 results")
			}

			const result1 = interceptor.validateToolUse("search_files", params1)
			expect(result1).toContain("🔄 LOOP DETECTED (1)")
			expect(result1).not.toContain("CRITICAL")

			// Try different params but still fail
			const params2 = { regex: "another_test", file_pattern: "*.py" }
			for (let i = 0; i < 3; i++) {
				interceptor.recordToolExecution("search_files", params2, "Found 0 results")
			}

			const result2 = interceptor.validateToolUse("search_files", params2)
			expect(result2).toContain("🔄 LOOP DETECTED (2 - CRITICAL)")
			expect(result2).toContain("🚨 CRITICAL")
			expect(result2).toContain("MANDATORY STRATEGY CHANGE")
		})

		it("should provide stronger guidance on repeated loops", () => {
			// Complete project exploration first
			interceptor.recordToolExecution("read_file", { path: "README.md" }, "Project README")
			interceptor.recordToolExecution("list_files", { path: "tests" }, "test files")

			// Trigger first loop
			const params1 = { command: "pytest test_a.py" }
			for (let i = 0; i < 3; i++) {
				interceptor.recordToolExecution("execute_command", params1, "ERROR: test not found")
			}
			const result1 = interceptor.validateToolUse("execute_command", params1)
			expect(result1).not.toBeNull()
			expect(result1).toContain("🔄 LOOP DETECTED (1)")

			// Trigger second loop with different params
			const params2 = { command: "pytest test_b.py" }
			for (let i = 0; i < 3; i++) {
				interceptor.recordToolExecution("execute_command", params2, "ERROR: test not found")
			}

			const result2 = interceptor.validateToolUse("execute_command", params2)
			expect(result2).not.toBeNull()
			if (result2) {
				expect(result2).toContain("STOP the current approach entirely")
				expect(result2).toContain("Try a completely different strategy")
				expect(result2).toContain("Consider that your assumptions might be wrong")
			}
		})
	})

	describe("Loop detection guidance", () => {
		it("should provide SWE-bench specific guidance", () => {
			const params = { regex: "test_method", file_pattern: "*.py" }

			for (let i = 0; i < 3; i++) {
				interceptor.recordToolExecution("search_files", params, "Found 0 results")
			}

			const result = interceptor.validateToolUse("search_files", params)
			expect(result).toContain("🎯 SWE-bench Task Reminder:")
			expect(result).toContain("Tests may not exist yet or be incomplete")
			expect(result).toContain("You may add test cases if they help validate your solution")
		})

		it("should suggest strategy changes", () => {
			// Complete project exploration first
			interceptor.recordToolExecution("read_file", { path: "README.md" }, "Project README")
			interceptor.recordToolExecution("list_files", { path: "tests" }, "test files")

			const params = { command: "pytest tests/test_example.py" }

			for (let i = 0; i < 3; i++) {
				interceptor.recordToolExecution("execute_command", params, "FAILED")
			}

			const result = interceptor.validateToolUse("execute_command", params)
			expect(result).toContain("💡 Strategy suggestions:")
			expect(result).toContain("Try different search keywords")
			expect(result).toContain("Check command correctness")
		})

		it("should show recent failed operations", () => {
			const params = { regex: "test_example", file_pattern: "*.py" }

			for (let i = 0; i < 3; i++) {
				interceptor.recordToolExecution("search_files", params, "Found 0 results")
			}

			const result = interceptor.validateToolUse("search_files", params)
			expect(result).toContain("Recent failed operations:")
			expect(result).toContain("search_files")
		})
	})

	describe("Loop detection reset", () => {
		it("should reset loop count when interceptor is reset", () => {
			const params = { regex: "test_example", file_pattern: "*.py" }

			// Trigger first loop
			for (let i = 0; i < 3; i++) {
				interceptor.recordToolExecution("search_files", params, "Found 0 results")
			}
			interceptor.validateToolUse("search_files", params)

			// Reset
			interceptor.reset()

			// Should not show escalated warning
			for (let i = 0; i < 3; i++) {
				interceptor.recordToolExecution("search_files", params, "Found 0 results")
			}

			const result = interceptor.validateToolUse("search_files", params)
			expect(result).toContain("🔄 LOOP DETECTED (1)")
			expect(result).not.toContain("CRITICAL")
		})
	})

	describe("Integration with failure guidance", () => {
		it("should provide guidance for failed search operations", () => {
			const params = { regex: "test_example", file_pattern: "*.py" }

			// Record failed search with guidance
			interceptor.recordToolExecution("search_files", params, "Found 0 results")

			// The guidance should be stored in execution history
			// This is tested indirectly through the loop detection message
		})

		it("should provide guidance for AttributeError in test execution", () => {
			const params = { command: "pytest tests/test_example.py::TestClass::test_method" }

			// Record failed execution with AttributeError
			interceptor.recordToolExecution(
				"execute_command",
				params,
				"AttributeError: module has no attribute 'test_method'",
			)

			// Guidance should be generated and stored
		})
	})
})
