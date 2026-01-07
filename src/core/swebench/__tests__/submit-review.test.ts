import { describe, it, expect, beforeEach, vi } from "vitest"
import {
	shouldShowSWEBenchReviewReminder,
	getSWEBenchReviewReminder,
	SWEBENCH_REVIEW_CHECKLIST,
	shouldShowFirstModificationGuidance,
	getFirstModificationGuidance,
	SWEBENCH_FIRST_MODIFICATION_GUIDANCE,
} from "../submit-review"
import { SWEBenchStateMachine } from "../state-machine"

// Mock Task class
const mockTask = {
	swebenchInterceptor: null as any,
}

describe("SWE-bench Submit Review", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("shouldShowSWEBenchReviewReminder", () => {
		it("should return false when no SWE-bench interceptor", () => {
			mockTask.swebenchInterceptor = null
			expect(shouldShowSWEBenchReviewReminder(mockTask as any)).toBe(false)
		})

		it("should return false when no modifications made", () => {
			const stateMachine = new SWEBenchStateMachine()
			// Simulate first attempt_completion without modifications
			stateMachine.recordToolUse("attempt_completion", { result: "done" })

			mockTask.swebenchInterceptor = {
				getStateMachine: () => stateMachine,
			}

			expect(shouldShowSWEBenchReviewReminder(mockTask as any)).toBe(false)
		})

		it("should return true on first attempt_completion with modifications", () => {
			const stateMachine = new SWEBenchStateMachine()

			// Simulate running tests first
			stateMachine.recordToolUse("execute_command", { command: "python -m pytest test_file.py::test_function" })

			// Then making modifications
			stateMachine.recordToolUse("apply_diff", { path: "test.py", diff: "some changes" })

			// First attempt_completion
			stateMachine.recordToolUse("attempt_completion", { result: "done" })

			mockTask.swebenchInterceptor = {
				getStateMachine: () => stateMachine,
			}

			// attemptCompletionCount is now 1, modificationCount > 0
			expect(shouldShowSWEBenchReviewReminder(mockTask as any)).toBe(true)
		})

		it("should return false on second attempt_completion", () => {
			const stateMachine = new SWEBenchStateMachine()

			// Simulate running tests first
			stateMachine.recordToolUse("execute_command", { command: "python -m pytest test_file.py::test_function" })

			// Then making modifications
			stateMachine.recordToolUse("apply_diff", { path: "test.py", diff: "some changes" })

			// First attempt_completion
			stateMachine.recordToolUse("attempt_completion", { result: "done" })

			// Second attempt_completion
			stateMachine.recordToolUse("attempt_completion", { result: "done" })

			mockTask.swebenchInterceptor = {
				getStateMachine: () => stateMachine,
			}

			// attemptCompletionCount is now 2, should not show reminder
			expect(shouldShowSWEBenchReviewReminder(mockTask as any)).toBe(false)
		})
	})

	describe("SWEBENCH_REVIEW_CHECKLIST", () => {
		it("should contain essential review items", () => {
			expect(SWEBENCH_REVIEW_CHECKLIST).toContain("FAIL_TO_PASS")
			expect(SWEBENCH_REVIEW_CHECKLIST).toContain("PASS_TO_PASS")
			expect(SWEBENCH_REVIEW_CHECKLIST).toContain("temporary")
			expect(SWEBENCH_REVIEW_CHECKLIST).toContain("real problem")
			expect(SWEBENCH_REVIEW_CHECKLIST).toContain("minimal")
		})

		it("should be a non-empty string", () => {
			expect(typeof SWEBENCH_REVIEW_CHECKLIST).toBe("string")
			expect(SWEBENCH_REVIEW_CHECKLIST.length).toBeGreaterThan(0)
		})
	})

	describe("getSWEBenchReviewReminder", () => {
		it("should return a reminder message containing the checklist", () => {
			const reminder = getSWEBenchReviewReminder()
			expect(reminder).toContain("SUBMISSION REVIEW REQUIRED")
			expect(reminder).toContain("attempt_completion")
			expect(reminder).toContain("NEXT STEP")
			expect(reminder).not.toContain("update_todo_list") // update_todo_list is disabled in swebench mode
		})
	})

	describe("shouldShowFirstModificationGuidance", () => {
		it("should return false when no SWE-bench interceptor", () => {
			mockTask.swebenchInterceptor = null
			expect(shouldShowFirstModificationGuidance(mockTask as any)).toBe(false)
		})

		it("should return true on first modification in ANALYZE phase without running tests", () => {
			const stateMachine = new SWEBenchStateMachine()
			// Fresh state: ANALYZE phase, no modifications, no tests run

			mockTask.swebenchInterceptor = {
				getStateMachine: () => stateMachine,
			}

			expect(shouldShowFirstModificationGuidance(mockTask as any)).toBe(true)
		})

		it("should return false after tests have been run", () => {
			const stateMachine = new SWEBenchStateMachine()
			// Run tests first
			stateMachine.recordToolUse("execute_command", { command: "python -m pytest test_file.py" })

			mockTask.swebenchInterceptor = {
				getStateMachine: () => stateMachine,
			}

			expect(shouldShowFirstModificationGuidance(mockTask as any)).toBe(false)
		})

		it("should return false after first modification", () => {
			const stateMachine = new SWEBenchStateMachine()
			// Make a modification (this will increment modificationCount)
			stateMachine.recordToolUse("apply_diff", { path: "test.py" })

			mockTask.swebenchInterceptor = {
				getStateMachine: () => stateMachine,
			}

			expect(shouldShowFirstModificationGuidance(mockTask as any)).toBe(false)
		})

		it("should return false in MODIFY phase", () => {
			const stateMachine = new SWEBenchStateMachine()
			// Run tests to transition to MODIFY phase
			stateMachine.recordToolUse("execute_command", { command: "python -m pytest test_file.py" })

			mockTask.swebenchInterceptor = {
				getStateMachine: () => stateMachine,
			}

			expect(stateMachine.getPhase()).toBe("MODIFY")
			expect(shouldShowFirstModificationGuidance(mockTask as any)).toBe(false)
		})
	})

	describe("getFirstModificationGuidance", () => {
		it("should return guidance message with systematic approach", () => {
			const guidance = getFirstModificationGuidance()
			expect(guidance).toContain("FIRST MODIFICATION BLOCKED")
			expect(guidance).toContain("Understand the problem")
			expect(guidance).toContain("Check test existence")
			expect(guidance).toContain("Implement solution")
			expect(guidance).toContain("Verify fix")
			expect(guidance).toContain("call apply_diff again")
		})
	})

	describe("SWEBENCH_FIRST_MODIFICATION_GUIDANCE", () => {
		it("should contain essential guidance items", () => {
			expect(SWEBENCH_FIRST_MODIFICATION_GUIDANCE).toContain("Understand the problem")
			expect(SWEBENCH_FIRST_MODIFICATION_GUIDANCE).toContain("FAIL_TO_PASS")
			expect(SWEBENCH_FIRST_MODIFICATION_GUIDANCE).toContain("PASS_TO_PASS")
			expect(SWEBENCH_FIRST_MODIFICATION_GUIDANCE).toContain("MODIFICATION BLOCKED")
		})
	})
})
