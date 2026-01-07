/**
 * Tests for output loop detection and stagnation detection in SWE-bench tool interceptor
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { SWEBenchToolInterceptor } from "../tool-interceptor"

describe("SWEBench Output Loop Detection", () => {
	let interceptor: SWEBenchToolInterceptor

	beforeEach(() => {
		interceptor = new SWEBenchToolInterceptor()
		// Mock Date.now for consistent testing
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe("Output Loop Detection", () => {
		it("should detect output loop when same content is repeated", () => {
			const sameOutput =
				"def test_missing_parent_link(self):\n    msg = 'Add parent_link=True to invalid_models_tests.ParkingLot.parent.'\n\n" +
				"# Additional repeated context to exceed minimum loop detection threshold.\n" +
				"# Additional repeated context to exceed minimum loop detection threshold.\n"

			// Record multiple executions with same output
			for (let i = 0; i < 8; i++) {
				interceptor.recordToolExecution("read_file", { path: "test.py" }, sameOutput)
			}

			// Next tool use should detect the loop
			const result = interceptor.validateToolUse("read_file", { path: "test.py" })

			expect(result).toContain("OUTPUT LOOP DETECTED")
			expect(result).toContain("repeating the same output content")
		})

		it("should not detect loop with varied outputs", () => {
			const outputs = [
				"output 1 - this is long enough to avoid being filtered out by minimum length threshold.",
				"output 2 - this is long enough to avoid being filtered out by minimum length threshold.",
				"output 3 - this is long enough to avoid being filtered out by minimum length threshold.",
				"output 4 - this is long enough to avoid being filtered out by minimum length threshold.",
				"output 5 - this is long enough to avoid being filtered out by minimum length threshold.",
			]

			outputs.forEach((output, i) => {
				interceptor.recordToolExecution("read_file", { path: `test${i}.py` }, output)
			})

			const result = interceptor.validateToolUse("read_file", { path: "test.py" })
			expect(result).toBeNull()
		})

		it("should require minimum number of outputs to detect loop", () => {
			const sameOutput =
				"repeated content - this is long enough to avoid being filtered out by minimum length threshold. " +
				"repeated content - this is long enough to avoid being filtered out by minimum length threshold."

			// Only 3 repetitions - should not trigger loop detection
			for (let i = 0; i < 3; i++) {
				interceptor.recordToolExecution("read_file", { path: "test.py" }, sameOutput)
			}

			const result = interceptor.validateToolUse("read_file", { path: "test.py" })
			expect(result).toBeNull()
		})
	})

	describe("Stagnation Detection", () => {
		it("should detect stagnation after 5 minutes without tool execution", () => {
			// Record initial tool execution
			interceptor.recordToolExecution("read_file", { path: "test.py" }, "content")

			// Advance time by 6 minutes
			vi.advanceTimersByTime(6 * 60 * 1000)

			const result = interceptor.validateToolUse("read_file", { path: "test.py" })

			expect(result).toContain("STAGNATION DETECTED")
			expect(result).toContain("No tool execution for over 5 minutes")
		})

		it("should not detect stagnation within 5 minutes", () => {
			// Record initial tool execution
			interceptor.recordToolExecution("read_file", { path: "test.py" }, "content")

			// Advance time by 4 minutes
			vi.advanceTimersByTime(4 * 60 * 1000)

			const result = interceptor.validateToolUse("read_file", { path: "test.py" })
			expect(result).toBeNull()
		})

		it("should provide phase-specific recovery guidance for ANALYZE phase", () => {
			// Set up ANALYZE phase
			interceptor.recordToolExecution("read_file", { path: "README.md" }, "content")

			// Advance time to trigger stagnation
			vi.advanceTimersByTime(6 * 60 * 1000)

			const result = interceptor.validateToolUse("read_file", { path: "test.py" })

			expect(result).toContain("STAGNATION DETECTED")
			expect(result).toContain("If you've found the tests, run them")
			expect(result).toContain("move to MODIFY phase")
		})
	})

	describe("Enhanced Failure Guidance", () => {
		it("should provide generic guidance for search failures", () => {
			const searchOutput = "Found 0 results."

			interceptor.recordToolExecution(
				"search_files",
				{
					regex: "test_clash_parent_link",
				},
				searchOutput,
			)

			// The guidance should be stored in the execution record
			const executionHistory = (interceptor as any).executionHistory
			const lastRecord = executionHistory[executionHistory.length - 1]
			expect(lastRecord.guidance).toContain("Test Discovery Tips")
			expect(lastRecord.guidance).toContain("clash_parent_link")
			expect(lastRecord.guidance).toContain("Tests may not exist yet or be incomplete")
		})

		it("should provide generic test runner guidance for AttributeError", () => {
			const errorOutput =
				"AttributeError: module 'invalid_models_tests' has no attribute 'test_clash_parent_link'"

			// Use a command that won't trigger isIndividualTestCommand check
			interceptor.recordToolExecution(
				"execute_command",
				{
					command: "python -m pytest tests/invalid_models_tests/",
				},
				errorOutput,
			)

			const executionHistory = (interceptor as any).executionHistory
			const lastRecord = executionHistory[executionHistory.length - 1]
			expect(lastRecord.guidance).toContain("correct test runner")
			expect(lastRecord.guidance).toContain("project-specific test runner scripts")
		})

		it("should provide module guidance for missing dependencies", () => {
			const errorOutput = "No module named 'pytest'"

			interceptor.recordToolExecution(
				"execute_command",
				{
					command: "pytest tests/",
				},
				errorOutput,
			)

			const executionHistory = (interceptor as any).executionHistory
			const lastRecord = executionHistory[executionHistory.length - 1]

			expect(lastRecord.guidance).toBeDefined()
			expect(lastRecord.guidance).toContain("DO NOT install dependencies")
			expect(lastRecord.guidance).toContain("project's native test runner")
		})
	})

	describe("Output History Management", () => {
		it("should limit output history size", () => {
			// Record more outputs than the limit
			for (let i = 0; i < 25; i++) {
				interceptor.recordToolExecution("read_file", { path: `test${i}.py` }, `output ${i}`)
			}

			const outputHistory = (interceptor as any).outputHistory
			expect(outputHistory.length).toBeLessThanOrEqual(20) // MAX_OUTPUT_HISTORY_SIZE
		})

		it("should track output timestamps", () => {
			const startTime = Date.now()

			interceptor.recordToolExecution("read_file", { path: "test.py" }, "content")

			const outputHistory = (interceptor as any).outputHistory
			expect(outputHistory[0].timestamp).toBeGreaterThanOrEqual(startTime)
			expect(outputHistory[0].toolName).toBe("read_file")
			expect(outputHistory[0].content).toBe("content")
		})
	})

	describe("Reset Functionality", () => {
		it("should reset all tracking state", () => {
			// Add some history
			interceptor.recordToolExecution("read_file", { path: "test.py" }, "content")
			interceptor.recordToolExecution("search_files", { regex: "test" }, "Found 0 results.")

			// Advance time
			vi.advanceTimersByTime(1000)

			// Reset
			interceptor.reset()

			// Check that all state is reset
			const executionHistory = (interceptor as any).executionHistory
			const outputHistory = (interceptor as any).outputHistory
			const loopDetectionCount = (interceptor as any).loopDetectionCount
			const lastToolExecutionTime = (interceptor as any).lastToolExecutionTime

			expect(executionHistory).toHaveLength(0)
			expect(outputHistory).toHaveLength(0)
			expect(loopDetectionCount).toBe(0)
			expect(lastToolExecutionTime).toBeGreaterThan(0) // Should be reset to current time
		})
	})
})
