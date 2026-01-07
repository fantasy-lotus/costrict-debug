import { describe, it, expect, beforeEach } from "vitest"
import { SWEBenchStateMachine } from "../state-machine"

describe("SWE-bench Robustness Fixes", () => {
	let stateMachine: SWEBenchStateMachine

	beforeEach(() => {
		stateMachine = new SWEBenchStateMachine()
	})

	describe("ANALYZE -> MODIFY transition robustness", () => {
		it("should transition to MODIFY even when output is missing", () => {
			// Execute test command without output (simulating missing output scenario)
			stateMachine.recordToolUse("execute_command", { command: "pytest test_example.py" }, undefined)

			expect(stateMachine.getPhase()).toBe("MODIFY")
			expect(stateMachine.getState().hasRunTests).toBe(true)
		})

		it("should transition to MODIFY when output is empty string", () => {
			stateMachine.recordToolUse("execute_command", { command: "pytest test_example.py" }, "")

			expect(stateMachine.getPhase()).toBe("MODIFY")
			expect(stateMachine.getState().hasRunTests).toBe(true)
		})

		it("should transition to MODIFY even when test execution clearly failed", () => {
			// After simplification, any test command transitions to MODIFY regardless of output
			stateMachine.recordToolUse(
				"execute_command",
				{ command: "pytest test_example.py" },
				"ModuleNotFoundError: No module named 'pytest'",
			)

			expect(stateMachine.getPhase()).toBe("MODIFY")
			expect(stateMachine.getState().hasRunTests).toBe(true) // Command was attempted
		})

		it("should transition to MODIFY with valid test output", () => {
			stateMachine.recordToolUse(
				"execute_command",
				{ command: "pytest test_example.py" },
				"collected 5 items\ntest_example.py::test_method FAILED\n5 failed",
			)

			expect(stateMachine.getPhase()).toBe("MODIFY")
			expect(stateMachine.getState().hasRunTests).toBe(true)
		})
	})

	describe("Simplified test execution logic", () => {
		it("should transition to MODIFY after any test command in ANALYZE", () => {
			stateMachine.recordToolUse("execute_command", { command: "pytest test_example.py" }, "test_example FAILED")
			expect(stateMachine.getPhase()).toBe("MODIFY")
		})

		it("should stay in VERIFY after any test command in VERIFY", () => {
			// Set up VERIFY phase
			stateMachine.recordToolUse("execute_command", { command: "pytest test_example.py" }, "test_example FAILED")
			stateMachine.recordToolUse("apply_diff", { path: "src/models.py" }, "Applied successfully")

			// Any test execution in VERIFY stays in VERIFY (can call attempt_completion)
			stateMachine.recordToolUse("execute_command", { command: "pytest test_example.py" }, "test_example PASSED")
			expect(stateMachine.getPhase()).toBe("VERIFY")
		})

		it("should let agents decide test results - stay in VERIFY", () => {
			// Set up VERIFY phase
			stateMachine.recordToolUse("execute_command", { command: "pytest test_example.py" }, "test_example FAILED")
			stateMachine.recordToolUse("apply_diff", { path: "src/models.py" }, "Applied successfully")

			// Even with failing output, stay in VERIFY (agent decides when to complete)
			stateMachine.recordToolUse(
				"execute_command",
				{ command: "pytest test_example.py" },
				"test_example FAILED\n1 failed",
			)
			expect(stateMachine.getPhase()).toBe("VERIFY")
		})
	})

	describe("VERIFY phase robustness", () => {
		beforeEach(() => {
			// Set up in VERIFY phase
			stateMachine.recordToolUse("execute_command", { command: "pytest test_example.py" }, "test_example FAILED")
			stateMachine.recordToolUse("apply_diff", { path: "src/models.py" }, "Applied successfully")
		})

		it("should stay in VERIFY with pytest output format", () => {
			stateMachine.recordToolUse(
				"execute_command",
				{ command: "pytest test_example.py" },
				"collected 5 items\ntest_example.py::test_method PASSED\n5 passed",
			)

			expect(stateMachine.getPhase()).toBe("VERIFY")
		})

		it("should stay in VERIFY with unittest output format", () => {
			stateMachine.recordToolUse(
				"execute_command",
				{ command: "python -m unittest test_example" },
				"Ran 5 tests in 0.123s\n\nOK",
			)

			expect(stateMachine.getPhase()).toBe("VERIFY")
		})

		it("should stay in VERIFY with Django test output format", () => {
			stateMachine.recordToolUse(
				"execute_command",
				{ command: "python manage.py test" },
				"Ran 5 tests in 0.123s\n\nOK",
			)

			expect(stateMachine.getPhase()).toBe("VERIFY")
		})

		it("should stay in VERIFY even when tests still fail", () => {
			// After simplification, any test execution in VERIFY stays in VERIFY
			// Let the agent decide when to call attempt_completion
			stateMachine.recordToolUse(
				"execute_command",
				{ command: "pytest test_example.py" },
				"collected 5 items\ntest_example.py::test_method FAILED\n1 failed, 4 passed",
			)

			expect(stateMachine.getPhase()).toBe("VERIFY")
		})

		it("should handle missing output gracefully in VERIFY phase", () => {
			// Verify we're in VERIFY phase from beforeEach setup
			expect(stateMachine.getPhase()).toBe("VERIFY")

			// Execute command without output - stays in VERIFY
			stateMachine.recordToolUse("execute_command", { command: "pytest test_example.py" }, undefined)

			expect(stateMachine.getPhase()).toBe("VERIFY")
		})
	})
})
