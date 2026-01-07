import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
	SWEBenchToolInterceptor,
	activateSWEBenchMode,
	deactivateSWEBenchMode,
	recordSWEBenchToolExecution,
} from "../tool-interceptor"

describe("SWE-bench Progress Logging", () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
	})

	afterEach(() => {
		consoleSpy.mockRestore()
		deactivateSWEBenchMode()
	})

	it("should log state machine information after tool execution", () => {
		activateSWEBenchMode()

		// Execute a test command
		recordSWEBenchToolExecution(
			"execute_command",
			{ command: "pytest test_foo.py" },
			"collected 5 items\ntest_foo.py::test_example FAILED\n5 failed",
		)

		// Check that state information was logged
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("[SWEBench-State] Phase: MODIFY"))
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Tests: 1"))
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Tool: execute_command"))
	})

	it("should log phase transitions", () => {
		activateSWEBenchMode()

		// Execute a test command to trigger ANALYZE -> MODIFY transition
		recordSWEBenchToolExecution(
			"execute_command",
			{ command: "pytest test_foo.py" },
			"collected 5 items\ntest_foo.py::test_example FAILED\n5 failed",
		)

		// Check that transition was logged
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("[SWEBench-Transition] ANALYZE -> MODIFY"))
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Reason: Valid test execution detected"))
	})

	it("should log project exploration progress", () => {
		activateSWEBenchMode()

		// Execute a read_file command for README
		recordSWEBenchToolExecution("read_file", { path: "README.md" }, "# Project README\nThis is a test project...")

		// Check that exploration progress was logged
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("[SWEBench-Exploration]"))
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("README: ✗"), // After simplification, README reading is not tracked
		)
	})

	it("should log git diff information for file modifications", () => {
		activateSWEBenchMode()

		// First run tests to get to MODIFY phase
		recordSWEBenchToolExecution(
			"execute_command",
			{ command: "pytest test_foo.py" },
			"collected 5 items\ntest_foo.py::test_example FAILED\n5 failed",
		)

		// Clear previous logs
		consoleSpy.mockClear()

		// Apply a diff (this will trigger git diff check)
		recordSWEBenchToolExecution("apply_diff", { path: "src/module.py" }, "Applied diff successfully")

		// Check that git diff information was attempted to be logged
		// Note: In test environment, git might not be available or repo might not exist
		// So we just check that the state logging happened
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("[SWEBench-State] Phase: VERIFY"))
	})

	it("should log complete workflow with all transitions", () => {
		activateSWEBenchMode()

		// 1. ANALYZE -> MODIFY: Run tests
		recordSWEBenchToolExecution(
			"execute_command",
			{ command: "pytest test_foo.py" },
			"collected 5 items\ntest_foo.py::test_example FAILED\n5 failed",
		)

		// 2. MODIFY -> VERIFY: Apply diff
		recordSWEBenchToolExecution("apply_diff", { path: "src/module.py" }, "Applied diff successfully")

		// 3. VERIFY: Run tests again (passing) - stays in VERIFY
		recordSWEBenchToolExecution(
			"execute_command",
			{ command: "pytest test_foo.py" },
			"collected 5 items\ntest_foo.py::test_example PASSED\n5 passed",
		)

		// Check all transitions were logged
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("[SWEBench-Transition] ANALYZE -> MODIFY"))
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("[SWEBench-Transition] MODIFY -> VERIFY"))
		// VERIFY no longer transitions to COMPLETE - stays in VERIFY

		// Check final state - stays in VERIFY
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("[SWEBench-State] Phase: VERIFY"))
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("Passed: NO"), // Simplified logic doesn't analyze test results
		)
	})
})
