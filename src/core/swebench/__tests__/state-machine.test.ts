import { describe, it, expect, beforeEach } from "vitest"
import {
	SWEBenchStateMachine,
	createInitialState,
	isTestCommand,
	PHASE_CONFIGS,
	type SWEBenchPhase,
} from "../state-machine"

describe("SWEBenchStateMachine", () => {
	let stateMachine: SWEBenchStateMachine

	beforeEach(() => {
		stateMachine = new SWEBenchStateMachine()
	})

	describe("initial state", () => {
		it("should start in ANALYZE phase", () => {
			expect(stateMachine.getPhase()).toBe("ANALYZE")
		})

		it("should have zero tests run", () => {
			expect(stateMachine.getState().testsRunCount).toBe(0)
		})

		it("should not have run tests", () => {
			expect(stateMachine.getState().hasRunTests).toBe(false)
		})
	})

	describe("tool allowance in ANALYZE phase", () => {
		it("should allow read_file", () => {
			expect(stateMachine.isToolAllowed("read_file")).toBe(true)
		})

		it("should allow list_files", () => {
			expect(stateMachine.isToolAllowed("list_files")).toBe(true)
		})

		it("should allow execute_command", () => {
			expect(stateMachine.isToolAllowed("execute_command")).toBe(true)
		})

		it("should NOT allow apply_diff on first attempt", () => {
			expect(stateMachine.isToolAllowed("apply_diff")).toBe(false)
		})

		it("should provide non-blocking guidance for first apply_diff attempt", () => {
			const reason = stateMachine.getBlockReason("apply_diff")
			// Changed to non-blocking - returns null but logs guidance
			expect(reason).toBeNull()
		})

		it("should allow apply_diff after first attempt", () => {
			// Record first modification
			stateMachine.recordToolUse("apply_diff", { path: "file.py", diff: "..." })

			// Second attempt should be allowed
			expect(stateMachine.isToolAllowed("apply_diff")).toBe(true)
			expect(stateMachine.getBlockReason("apply_diff")).toBeNull()
		})
	})

	describe("phase transitions", () => {
		it("should transition to MODIFY after running tests", () => {
			stateMachine.recordToolUse(
				"execute_command",
				{ command: "python -m pytest test_foo.py" },
				"collected 5 items\ntest_foo.py::test_example FAILED\n5 failed",
			)
			expect(stateMachine.getPhase()).toBe("MODIFY")
		})

		it("should allow apply_diff after running tests", () => {
			stateMachine.recordToolUse(
				"execute_command",
				{ command: "pytest test_foo.py" },
				"collected 5 items\ntest_foo.py::test_example FAILED\n5 failed",
			)
			expect(stateMachine.isToolAllowed("apply_diff")).toBe(true)
		})

		it("should allow apply_diff (the only code modification tool) after running tests", () => {
			stateMachine.recordToolUse(
				"execute_command",
				{ command: "pytest test_foo.py" },
				"collected 5 items\ntest_foo.py::test_example FAILED\n5 failed",
			)
			expect(stateMachine.isToolAllowed("apply_diff")).toBe(true)
		})

		it("should remain in MODIFY immediately after applying diff", () => {
			// First run tests to get to MODIFY
			stateMachine.recordToolUse(
				"execute_command",
				{ command: "pytest test_foo.py" },
				"collected 5 items\ntest_foo.py::test_example FAILED\n5 failed",
			)
			expect(stateMachine.getPhase()).toBe("MODIFY")

			// Then apply diff
			stateMachine.recordToolUse("apply_diff", { path: "foo.py", diff: "..." })
			expect(stateMachine.getPhase()).toBe("MODIFY")
		})

		it("should transition to VERIFY after enough execute_command calls post-modification", () => {
			// First run tests to get to MODIFY
			stateMachine.recordToolUse(
				"execute_command",
				{ command: "pytest test_foo.py" },
				"collected 5 items\ntest_foo.py::test_example FAILED\n5 failed",
			)
			expect(stateMachine.getPhase()).toBe("MODIFY")

			// Apply diff (still MODIFY)
			stateMachine.recordToolUse("apply_diff", { path: "foo.py", diff: "..." })
			expect(stateMachine.getPhase()).toBe("MODIFY")

			// Run arbitrary commands after modification until transition
			stateMachine.recordToolUse("execute_command", { command: "echo 1" }, "")
			stateMachine.recordToolUse("execute_command", { command: "echo 2" }, "")
			stateMachine.recordToolUse("execute_command", { command: "echo 3" }, "")
			stateMachine.recordToolUse("execute_command", { command: "echo 4" }, "")
			expect(stateMachine.getPhase()).toBe("MODIFY")
			stateMachine.recordToolUse("execute_command", { command: "echo 5" }, "")
			expect(stateMachine.getPhase()).toBe("VERIFY")
		})

		it("should stay in VERIFY when tests pass after modification", () => {
			// Run tests -> MODIFY
			stateMachine.recordToolUse(
				"execute_command",
				{ command: "pytest test_foo.py" },
				"collected 5 items\ntest_foo.py::test_example FAILED\n5 failed",
			)

			// Apply diff (still MODIFY)
			stateMachine.recordToolUse("apply_diff", { path: "foo.py", diff: "..." })

			// Run enough test commands after modifications -> transition to VERIFY
			for (let i = 0; i < 5; i++) {
				stateMachine.recordToolUse(
					"execute_command",
					{ command: "pytest test_foo.py" },
					"collected 5 items\ntest_foo.py::test_example PASSED\n5 passed",
				)
			}
			expect(stateMachine.getPhase()).toBe("VERIFY")

			// Run tests in VERIFY phase -> stay in VERIFY (regardless of result)
			stateMachine.recordToolUse(
				"execute_command",
				{ command: "pytest test_foo.py" },
				"collected 5 items\ntest_foo.py::test_example FAILED\n5 failed",
			)
			expect(stateMachine.getPhase()).toBe("VERIFY")
		})

		it("should stay in VERIFY when running tests in VERIFY phase", () => {
			// Run tests -> MODIFY
			stateMachine.recordToolUse(
				"execute_command",
				{ command: "pytest test_foo.py" },
				"collected 5 items\ntest_foo.py::test_example FAILED\n5 failed",
			)

			// Apply diff (still MODIFY)
			stateMachine.recordToolUse("apply_diff", { path: "foo.py", diff: "..." })

			// Run enough test commands after modifications -> transition to VERIFY
			for (let i = 0; i < 5; i++) {
				stateMachine.recordToolUse(
					"execute_command",
					{ command: "pytest test_foo.py" },
					"collected 5 items\ntest_foo.py::test_example FAILED\n5 failed",
				)
			}
			expect(stateMachine.getPhase()).toBe("VERIFY")

			// Run tests in VERIFY phase -> stay in VERIFY (regardless of result)
			stateMachine.recordToolUse(
				"execute_command",
				{ command: "pytest test_foo.py" },
				"collected 5 items\ntest_foo.py::test_example FAILED\n5 failed",
			)
			expect(stateMachine.getPhase()).toBe("VERIFY")
		})
	})

	describe("test command detection", () => {
		it("should detect pytest commands", () => {
			expect(isTestCommand("python -m pytest test_foo.py")).toBe(true)
			expect(isTestCommand("pytest test_foo.py")).toBe(true)
			expect(isTestCommand("pytest -xvs tests/")).toBe(true)
		})

		it("should detect Django test commands", () => {
			expect(isTestCommand("python manage.py test")).toBe(true)
		})

		it("should detect unittest commands", () => {
			expect(isTestCommand("python -m unittest test_module")).toBe(true)
		})

		it("should detect tox/nox commands", () => {
			expect(isTestCommand("tox -e py39")).toBe(true)
			expect(isTestCommand("nox -s tests")).toBe(true)
		})

		it("should detect custom test runners", () => {
			expect(isTestCommand("./runtests.py")).toBe(true)
		})

		it("should NOT detect non-test commands", () => {
			expect(isTestCommand("python foo.py")).toBe(false)
			expect(isTestCommand("pip install pytest")).toBe(false)
			expect(isTestCommand("git status")).toBe(false)
		})

		it("should detect test commands in chained commands", () => {
			expect(isTestCommand("pip install -e . && pytest")).toBe(true)
			expect(isTestCommand("pip install -e .; python -m pytest test_foo.py")).toBe(true)
			expect(isTestCommand("cd /workspace && pytest tests/")).toBe(true)
		})

		it("should NOT detect pure install commands even when chained", () => {
			expect(isTestCommand("pip install -e . && pip install pytest")).toBe(false)
		})
	})

	describe("state tracking", () => {
		it("should track test run count", () => {
			stateMachine.recordToolUse("execute_command", { command: "pytest test_foo.py" })
			expect(stateMachine.getState().testsRunCount).toBe(1)

			stateMachine.recordToolUse("execute_command", { command: "pytest test_bar.py" })
			expect(stateMachine.getState().testsRunCount).toBe(2)
		})

		it("should track modification count", () => {
			// Get to MODIFY phase first
			stateMachine.recordToolUse("execute_command", { command: "pytest test_foo.py" })

			stateMachine.recordToolUse("apply_diff", { path: "foo.py", diff: "..." })
			expect(stateMachine.getState().modificationCount).toBe(1)

			stateMachine.recordToolUse("apply_diff", { path: "bar.py", diff: "..." })
			expect(stateMachine.getState().modificationCount).toBe(2)
		})

		it("should track hasRunTests flag", () => {
			expect(stateMachine.getState().hasRunTests).toBe(false)

			stateMachine.recordToolUse("execute_command", { command: "pytest test_foo.py" })
			expect(stateMachine.getState().hasRunTests).toBe(true)
		})
	})

	describe("serialization", () => {
		it("should serialize and deserialize state", () => {
			// Modify state
			stateMachine.recordToolUse("execute_command", { command: "pytest test_foo.py" })
			stateMachine.recordToolUse("apply_diff", { path: "foo.py", diff: "..." })

			// Serialize
			const serialized = stateMachine.serialize()

			// Deserialize
			const restored = SWEBenchStateMachine.deserialize(serialized)

			expect(restored.getPhase()).toBe(stateMachine.getPhase())
			expect(restored.getState().testsRunCount).toBe(stateMachine.getState().testsRunCount)
			expect(restored.getState().modificationCount).toBe(stateMachine.getState().modificationCount)
		})
	})

	describe("force phase transition", () => {
		it("should allow forcing phase transition to valid phases", () => {
			expect(stateMachine.getPhase()).toBe("ANALYZE")

			stateMachine.forcePhase("MODIFY")
			expect(stateMachine.getPhase()).toBe("MODIFY")

			stateMachine.forcePhase("VERIFY")
			expect(stateMachine.getPhase()).toBe("VERIFY")

			stateMachine.forcePhase("ANALYZE")
			expect(stateMachine.getPhase()).toBe("ANALYZE")
		})

		it("should allow attempt_completion after forcing to VERIFY", () => {
			stateMachine.forcePhase("VERIFY")
			expect(stateMachine.getPhase()).toBe("VERIFY")
			expect(stateMachine.isToolAllowed("attempt_completion")).toBe(true)
			expect(stateMachine.getBlockReason("attempt_completion")).toBe(null)
		})
	})

	describe("attempt_completion validation", () => {
		it("should allow attempt_completion only in VERIFY phase", () => {
			// ANALYZE phase - should be blocked
			expect(stateMachine.isToolAllowed("attempt_completion")).toBe(false)
			expect(stateMachine.getBlockReason("attempt_completion")).toContain(
				"Cannot attempt completion in ANALYZE phase",
			)

			// Transition to MODIFY
			stateMachine.recordToolUse(
				"execute_command",
				{ command: "python -m pytest test_file.py" },
				"collected 5 items\ntest_file.py::test_example FAILED\n5 failed",
			)
			expect(stateMachine.getPhase()).toBe("MODIFY")
			expect(stateMachine.isToolAllowed("attempt_completion")).toBe(false)
			expect(stateMachine.getBlockReason("attempt_completion")).toContain(
				"Cannot attempt completion in MODIFY phase",
			)

			// Apply diff (still MODIFY)
			stateMachine.recordToolUse("apply_diff", { path: "file.py", diff: "some diff" })
			expect(stateMachine.getPhase()).toBe("MODIFY")
			expect(stateMachine.isToolAllowed("attempt_completion")).toBe(false)
			expect(stateMachine.getBlockReason("attempt_completion")).toContain(
				"Cannot attempt completion in MODIFY phase",
			)

			// Transition to VERIFY after enough execute_command calls after modifications
			for (let i = 0; i < 5; i++) {
				stateMachine.recordToolUse(
					"execute_command",
					{ command: "python -m pytest test_file.py" },
					"collected 5 items\ntest_file.py::test_example FAILED\n5 failed",
				)
			}
			expect(stateMachine.getPhase()).toBe("VERIFY")
			expect(stateMachine.isToolAllowed("attempt_completion")).toBe(true)
			expect(stateMachine.getBlockReason("attempt_completion")).toBe(null)
		})

		it("should allow completion without running tests (flexible strategy)", () => {
			// Force to VERIFY phase (COMPLETE phase removed)
			stateMachine.forcePhase("VERIFY")

			// Should be allowed - no longer require tests to be run
			expect(stateMachine.getBlockReason("attempt_completion")).toBe(null)

			// Run tests (optional)
			stateMachine.recordToolUse("execute_command", { command: "python -m pytest test_file.py" }, "PASSED")

			// Still should be allowed
			expect(stateMachine.getBlockReason("attempt_completion")).toBe(null)
		})

		it("should allow completion in VERIFY phase even with unverified changes (flexible strategy)", () => {
			// Run initial tests and make modifications
			stateMachine.recordToolUse("execute_command", { command: "python -m pytest test_file.py" }, "FAILED")
			stateMachine.recordToolUse("apply_diff", { path: "file.py", diff: "some diff" })

			// Still in MODIFY until enough execute_command calls after modifications
			expect(stateMachine.getPhase()).toBe("MODIFY")
			expect(stateMachine.getBlockReason("attempt_completion")).toContain(
				"Cannot attempt completion in MODIFY phase",
			)
			for (let i = 0; i < 5; i++) {
				stateMachine.recordToolUse("execute_command", { command: "python -m pytest test_file.py" }, "PASSED")
			}

			// Now in VERIFY phase and allow attempt_completion
			expect(stateMachine.getPhase()).toBe("VERIFY")
			expect(stateMachine.getBlockReason("attempt_completion")).toBe(null)

			// Verify tests pass (optional)
			stateMachine.recordToolUse("execute_command", { command: "python -m pytest test_file.py" }, "PASSED")

			// Still in VERIFY and should be allowed
			expect(stateMachine.getPhase()).toBe("VERIFY")
			expect(stateMachine.getBlockReason("attempt_completion")).toBe(null)
		})

		it("should track attempt_completion calls", () => {
			// Move to VERIFY phase first
			stateMachine.recordToolUse("execute_command", { command: "pytest test_file.py" }, "FAILED")
			stateMachine.recordToolUse("apply_diff", { path: "file.py", diff: "some diff" })
			for (let i = 0; i < 5; i++) {
				stateMachine.recordToolUse("execute_command", { command: "pytest test_file.py" }, "FAILED")
			}
			expect(stateMachine.getPhase()).toBe("VERIFY")

			// Initial count
			expect(stateMachine.getState().attemptCompletionCount).toBe(0)

			// Record attempt_completion - should stay in VERIFY phase
			stateMachine.recordToolUse("attempt_completion", { result: "Task completed" })
			expect(stateMachine.getPhase()).toBe("VERIFY")
			expect(stateMachine.getState().attemptCompletionCount).toBe(1)

			// Record another attempt - should still be in VERIFY
			stateMachine.recordToolUse("attempt_completion", { result: "Final result" })
			expect(stateMachine.getPhase()).toBe("VERIFY")
			expect(stateMachine.getState().attemptCompletionCount).toBe(2)
		})

		it("should not transition from VERIFY when calling attempt_completion", () => {
			// Move to VERIFY phase
			stateMachine.recordToolUse("execute_command", { command: "pytest test_file.py" }, "FAILED")
			stateMachine.recordToolUse("apply_diff", { path: "file.py", diff: "some diff" })
			for (let i = 0; i < 5; i++) {
				stateMachine.recordToolUse("execute_command", { command: "pytest test_file.py" }, "FAILED")
			}
			expect(stateMachine.getPhase()).toBe("VERIFY")

			// Call attempt_completion - should stay in VERIFY
			stateMachine.recordToolUse("attempt_completion", { result: "Solution ready" })
			expect(stateMachine.getPhase()).toBe("VERIFY")
			expect(stateMachine.isToolAllowed("attempt_completion")).toBe(true)
		})
	})

	describe("phase guidance", () => {
		it("should provide phase-specific guidance", () => {
			// ANALYZE phase guidance
			let guidance = stateMachine.getPhaseGuidance()
			expect(guidance).toContain("CURRENT PHASE: ANALYZE")
			expect(guidance).toContain("Run FAIL_TO_PASS tests")
			expect(guidance).toContain("❌ Tests not yet run")

			// After running tests
			stateMachine.recordToolUse(
				"execute_command",
				{ command: "python -m pytest test_file.py" },
				"collected 5 items\ntest_file.py::test_example FAILED\n5 failed",
			)
			guidance = stateMachine.getPhaseGuidance()
			expect(guidance).toContain("CURRENT PHASE: MODIFY")
			expect(guidance).toContain("Make minimal code changes")

			// After modifications (still MODIFY until enough execute_command calls)
			stateMachine.recordToolUse("apply_diff", { path: "file.py", diff: "some diff" })
			guidance = stateMachine.getPhaseGuidance()
			expect(guidance).toContain("CURRENT PHASE: MODIFY")
			expect(guidance).toContain("Make minimal code changes")

			// After enough execute_command calls -> VERIFY guidance
			for (let i = 0; i < 5; i++) {
				stateMachine.recordToolUse(
					"execute_command",
					{ command: "python -m pytest test_file.py" },
					"collected 5 items\ntest_file.py::test_example FAILED\n5 failed",
				)
			}
			guidance = stateMachine.getPhaseGuidance()
			expect(guidance).toContain("CURRENT PHASE: VERIFY")
			expect(guidance).toContain("VERIFICATION RECOMMENDED")

			// After verification - stays in VERIFY
			stateMachine.recordToolUse(
				"execute_command",
				{ command: "python -m pytest test_file.py" },
				"collected 5 items\ntest_file.py::test_example PASSED\n5 passed",
			)
			guidance = stateMachine.getPhaseGuidance()
			expect(guidance).toContain("CURRENT PHASE: VERIFY")
			expect(guidance).toContain("attempt_completion")
		})

		it("should show modified files in guidance", () => {
			// Run tests and modify files
			stateMachine.recordToolUse(
				"execute_command",
				{ command: "pytest test_file.py" },
				"collected 5 items\ntest_file.py::test_example FAILED\n5 failed",
			)
			stateMachine.recordToolUse("apply_diff", { path: "src/module.py", diff: "some diff" })
			stateMachine.recordToolUse("apply_diff", { path: "src/utils.py", diff: "another diff" })

			const guidance = stateMachine.getPhaseGuidance()
			expect(guidance).toContain("Modified files: src/module.py, src/utils.py")
		})
	})
})
