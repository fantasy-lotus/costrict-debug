import { describe, it, expect, beforeEach } from "vitest"
import { SWEBenchStateMachine } from "../state-machine"

describe("SWE-bench Test Discovery Guidance", () => {
	let stateMachine: SWEBenchStateMachine

	beforeEach(() => {
		stateMachine = new SWEBenchStateMachine()
	})

	it("should include test discovery algorithm in ANALYZE phase guidance", () => {
		const guidance = stateMachine.getPhaseGuidance()

		// Check for key components of the test discovery algorithm
		expect(guidance).toContain("TEST DISCOVERY ALGORITHM")
		expect(guidance).toContain("Discover the project's test runner through exploration")
		expect(guidance).toContain("Test location strategy")
		expect(guidance).toContain("Hard fallback rules")

		// Check for generic guidance points (no Django-specific content)
		expect(guidance).toContain("Read README.md, CONTRIBUTING.md, or docs/")
		expect(guidance).toContain("Look for test runner scripts")
		expect(guidance).toContain("runtests.py, manage.py, test.py")
		expect(guidance).toContain("do NOT install dependencies")
		expect(guidance).toContain("use project's native runner")
	})

	it("should include critical reminders about test expectations", () => {
		const guidance = stateMachine.getPhaseGuidance()

		expect(guidance).toContain("CRITICAL REMINDERS")
		expect(guidance).toContain("Tests may not exist yet or be incomplete")
		expect(guidance).toContain("evaluation system may add tests via test_patch")
		expect(guidance).toContain("Focus on understanding the problem and implementing the correct fix")
	})

	it("should include SWE-bench task objective", () => {
		const guidance = stateMachine.getPhaseGuidance()

		expect(guidance).toContain("SWE-BENCH TASK OBJECTIVE")
		expect(guidance).toContain("Understand the issue described in the problem statement")
		expect(guidance).toContain("Modify existing code to solve the problem")
		expect(guidance).toContain("Make FAIL_TO_PASS tests change from failing to passing")
		expect(guidance).toContain("Keep PASS_TO_PASS tests continuing to pass")
	})

	it("should not include test discovery guidance in other phases", () => {
		// Transition to MODIFY phase by providing valid test output
		stateMachine.recordToolUse(
			"execute_command",
			{ command: "python -m pytest" },
			"collected 5 items\ntest_example.py::test_method FAILED\n5 failed",
		)

		const modifyGuidance = stateMachine.getPhaseGuidance()
		expect(modifyGuidance).not.toContain("TEST DISCOVERY ALGORITHM")
		expect(modifyGuidance).toContain("GOAL: Modify code to make FAIL_TO_PASS tests pass")
	})
})
