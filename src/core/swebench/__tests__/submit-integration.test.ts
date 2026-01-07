import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { shouldShowSWEBenchReviewReminder, getSWEBenchReviewReminder, hasModifiedTestFiles } from "../submit-review"
import { activateSWEBenchMode, deactivateSWEBenchMode } from "../tool-interceptor"

describe("SWE-bench Submit Integration", () => {
	beforeEach(() => {
		deactivateSWEBenchMode()
	})

	afterEach(() => {
		deactivateSWEBenchMode()
	})

	it("should show reminder on first attempt_completion with modifications", () => {
		// Activate SWE-bench mode and simulate modifications
		const interceptor = activateSWEBenchMode()

		// Simulate the workflow: run tests, then make modifications
		const stateMachine = interceptor.getStateMachine()
		stateMachine.recordToolUse("execute_command", { command: "python -m pytest test_file.py" })
		stateMachine.recordToolUse("apply_diff", { path: "file.py", diff: "changes" })

		// First attempt_completion
		stateMachine.recordToolUse("attempt_completion", { result: "done" })

		const mockTask = { swebenchInterceptor: interceptor }

		// Should show reminder on first attempt
		expect(shouldShowSWEBenchReviewReminder(mockTask as any)).toBe(true)
	})

	it("should not show reminder on second attempt_completion", () => {
		// Activate SWE-bench mode and simulate modifications
		const interceptor = activateSWEBenchMode()

		// Simulate the workflow: run tests, then make modifications
		const stateMachine = interceptor.getStateMachine()
		stateMachine.recordToolUse("execute_command", { command: "python -m pytest test_file.py" })
		stateMachine.recordToolUse("apply_diff", { path: "file.py", diff: "changes" })

		// First attempt_completion
		stateMachine.recordToolUse("attempt_completion", { result: "done" })

		// Second attempt_completion
		stateMachine.recordToolUse("attempt_completion", { result: "done" })

		const mockTask = { swebenchInterceptor: interceptor }

		// Should NOT show reminder on second attempt
		expect(shouldShowSWEBenchReviewReminder(mockTask as any)).toBe(false)
	})

	it("should not show reminder when no modifications made", () => {
		// Activate SWE-bench mode but don't make modifications
		const interceptor = activateSWEBenchMode()

		// First attempt_completion without modifications
		const stateMachine = interceptor.getStateMachine()
		stateMachine.recordToolUse("attempt_completion", { result: "done" })

		const mockTask = { swebenchInterceptor: interceptor }

		expect(shouldShowSWEBenchReviewReminder(mockTask as any)).toBe(false)
	})

	it("should track modified files including test files", () => {
		const interceptor = activateSWEBenchMode()
		const stateMachine = interceptor.getStateMachine()

		// Simulate modifications to both regular and test files
		stateMachine.recordToolUse("apply_diff", { path: "src/module.py" })
		stateMachine.recordToolUse("apply_diff", { path: "test_module.py" })
		stateMachine.recordToolUse("apply_diff", { path: "tests/test_utils.py" })

		const state = stateMachine.getState()
		expect(state.modifiedFiles).toContain("src/module.py")
		expect(state.modifiedFiles).toContain("test_module.py")
		expect(state.modifiedFiles).toContain("tests/test_utils.py")

		const mockTask = { swebenchInterceptor: interceptor }
		const modifiedTestFiles = hasModifiedTestFiles(mockTask as any)
		expect(modifiedTestFiles).toContain("test_module.py")
		expect(modifiedTestFiles).toContain("tests/test_utils.py")
		expect(modifiedTestFiles).not.toContain("src/module.py")
	})

	it("should return proper reminder message", () => {
		const reminder = getSWEBenchReviewReminder()

		expect(reminder).toContain("SUBMISSION REVIEW REQUIRED")
		expect(reminder).toContain("FAIL_TO_PASS")
		expect(reminder).toContain("PASS_TO_PASS")
		expect(reminder).toContain("attempt_completion")
		expect(reminder).toContain("NEXT STEP")
		expect(reminder).not.toContain("update_todo_list") // update_todo_list is disabled in swebench mode
	})

	it("should include test file warning when test files are modified", () => {
		const testFiles = ["test_example.py", "tests/test_module.py"]
		const reminder = getSWEBenchReviewReminder(testFiles)

		expect(reminder).toContain("NOTE: Test file modifications detected")
		expect(reminder).toContain("test_example.py")
		expect(reminder).toContain("tests/test_module.py")
		expect(reminder).toContain("Focus on solving the real problem")
		expect(reminder).toContain("not gaming the tests")
	})
})
