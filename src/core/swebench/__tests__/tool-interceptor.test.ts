import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

vi.mock("../instance-prompts", () => ({
	generateInstanceTestDiscoveryGuidance: () => "REPOSITORY-SPECIFIC TEST DISCOVERY",
}))

import {
	SWEBenchToolInterceptor,
	activateSWEBenchMode,
	deactivateSWEBenchMode,
	isSWEBenchModeActive,
	validateSWEBenchToolUse,
	recordSWEBenchToolExecution,
	getActiveSWEBenchInterceptor,
	applySWEBenchPathMapping,
} from "../tool-interceptor"

describe("SWEBenchToolInterceptor", () => {
	let interceptor: SWEBenchToolInterceptor

	beforeEach(() => {
		interceptor = new SWEBenchToolInterceptor()
	})

	describe("validateToolUse", () => {
		it("should provide non-blocking guidance on first modification attempt in ANALYZE phase", () => {
			const result = interceptor.validateToolUseLegacy("apply_diff")
			// Changed to non-blocking - should return null but log guidance
			expect(result).toBeNull()
		})

		it("should reset apply_diff thrash counter after sequential-thinking MCP tool execution", () => {
			// Simulate 3 apply_diff executions to reach the block threshold on next attempt
			for (let i = 0; i < 3; i++) {
				interceptor.recordToolExecution("apply_diff", { path: `file${i}.py`, diff: "..." })
			}

			// Confirm the next apply_diff attempt would be blocked
			const blockedBefore = interceptor.validateToolUseLegacy("apply_diff", { path: "file3.py", diff: "..." })
			expect(blockedBefore).toContain("Jinnang Triggered")

			// Now simulate a sequential-thinking MCP call, which should reset the thrash counter
			interceptor.recordToolExecution("mcp--sequential-thinking--sequentialthinking" as any, {})

			// After reset, apply_diff should be allowed again
			const allowedAfter = interceptor.validateToolUseLegacy("apply_diff", { path: "file4.py", diff: "..." })
			expect(allowedAfter).toBeNull()
		})

		it("should provide a non-blocking second jinnang nudge after the 2nd apply_diff execution", () => {
			// First apply_diff execution: no nudge
			let guidance = interceptor.recordToolExecution("apply_diff", { path: "file0.py", diff: "..." })
			expect(guidance).toBeNull()

			// Second apply_diff execution: should return a nudge
			guidance = interceptor.recordToolExecution("apply_diff", { path: "file1.py", diff: "..." })
			expect(guidance).toContain("Quick Nudge")
		})

		it("should block the 4th apply_diff attempt with jinnang guidance and reset the counter", () => {
			// Simulate 3 apply_diff executions
			for (let i = 0; i < 3; i++) {
				interceptor.recordToolExecution("apply_diff", { path: `file${i}.py`, diff: "..." })
			}

			// The 4th apply_diff attempt should be blocked
			const blocked = interceptor.validateToolUseLegacy("apply_diff", { path: "file3.py", diff: "..." })
			expect(blocked).toContain("Jinnang Triggered")

			// After being blocked, the counter should be reset so the next attempt is allowed
			const allowedAfterReset = interceptor.validateToolUseLegacy("apply_diff", { path: "file4.py", diff: "..." })
			expect(allowedAfterReset).toBeNull()
		})

		it("should NOT reset apply_diff count when a non-apply_diff tool is used", () => {
			for (let i = 0; i < 3; i++) {
				interceptor.recordToolExecution("apply_diff", { path: `file${i}.py`, diff: "..." })
			}

			// Non-apply_diff tools should NOT reset the counter
			const readAllowed = interceptor.validateToolUseLegacy("read_file", { path: "foo.py" })
			expect(readAllowed).toBeNull()

			// Next apply_diff should still be blocked because the counter is not reset
			const blocked = interceptor.validateToolUseLegacy("apply_diff", { path: "file3.py", diff: "..." })
			expect(blocked).toContain("Jinnang Triggered")
		})

		it("should include repository-specific guidance when instanceId is set", () => {
			const interceptorWithInstance = new SWEBenchToolInterceptor({}, "django__django-11532")
			for (let i = 0; i < 4; i++) {
				interceptorWithInstance.recordToolExecution("apply_diff", { path: `file${i}.py`, diff: "..." })
			}

			const blocked = interceptorWithInstance.validateToolUseLegacy("apply_diff", {
				path: "file4.py",
				diff: "...",
			})
			expect(blocked).toContain("Repository-specific guidance")
			expect(blocked).toContain("REPOSITORY-SPECIFIC TEST DISCOVERY")
		})

		it("should allow read_file in ANALYZE phase", () => {
			const result = interceptor.validateToolUseLegacy("read_file")
			expect(result).toBeNull()
		})

		it("should allow second modification attempt without any issues", () => {
			// First attempt should be allowed (non-blocking)
			let result = interceptor.validateToolUseLegacy("apply_diff")
			expect(result).toBeNull()

			// Record the first modification attempt
			interceptor.recordToolExecution("apply_diff", { path: "file.py" })

			// Second attempt should also be allowed
			result = interceptor.validateToolUseLegacy("apply_diff")
			expect(result).toBeNull()
		})

		it("should allow execute_command in ANALYZE phase", () => {
			const result = interceptor.validateToolUseLegacy("execute_command")
			expect(result).toBeNull()
		})

		it("should allow apply_diff after running tests", () => {
			// Run tests first with valid test output
			interceptor.recordToolExecution(
				"execute_command",
				{ command: "pytest test_foo.py" },
				"collected 5 items\ntest_foo.py::test_example FAILED\n5 failed",
			)

			// Now apply_diff should be allowed
			const result = interceptor.validateToolUseLegacy("apply_diff")
			expect(result).toBeNull()
		})
	})

	describe("recordToolExecution", () => {
		it("should track test execution", () => {
			expect(interceptor.hasRunTests()).toBe(false)

			interceptor.recordToolExecution(
				"execute_command",
				{ command: "pytest test_foo.py" },
				"collected 5 items\ntest_foo.py::test_example FAILED\n5 failed",
			)

			expect(interceptor.hasRunTests()).toBe(true)
		})

		it("should transition phases correctly", () => {
			expect(interceptor.getCurrentPhase()).toBe("ANALYZE")

			// Run tests -> MODIFY (with valid test output)
			interceptor.recordToolExecution(
				"execute_command",
				{ command: "pytest test_foo.py" },
				"collected 5 items\ntest_foo.py::test_example FAILED\n5 failed",
			)
			expect(interceptor.getCurrentPhase()).toBe("MODIFY")

			// Apply diff -> still MODIFY (VERIFY is reached after follow-up execute_command calls)
			interceptor.recordToolExecution("apply_diff", { path: "foo.py", diff: "..." })
			expect(interceptor.getCurrentPhase()).toBe("MODIFY")

			// Run a few commands after modifications -> VERIFY (threshold is 5)
			for (let i = 0; i < 5; i++) {
				interceptor.recordToolExecution("execute_command", { command: "echo ok" }, "ok")
			}
			expect(interceptor.getCurrentPhase()).toBe("VERIFY")
		})
	})

	describe("non-strict mode", () => {
		it("should warn but not block in non-strict mode", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			const nonStrictInterceptor = new SWEBenchToolInterceptor({ strictMode: false })

			const result = nonStrictInterceptor.validateToolUseLegacy("apply_diff")

			expect(result).toBeNull() // Should not block
			expect(warnSpy).toHaveBeenCalled()

			warnSpy.mockRestore()
		})
	})

	describe("callbacks", () => {
		it("should call onToolBlocked when tool is blocked", () => {
			const onToolBlocked = vi.fn()
			const callbackInterceptor = new SWEBenchToolInterceptor({ strictMode: true, onToolBlocked })

			// Use a tool that's actually blocked (not apply_diff which is now non-blocking)
			callbackInterceptor.validateToolUse("attempt_completion")

			expect(onToolBlocked).toHaveBeenCalledWith("attempt_completion", expect.any(String))
		})

		it("should call onStateChange when phase changes", () => {
			const onStateChange = vi.fn()
			const callbackInterceptor = new SWEBenchToolInterceptor({ strictMode: true, onStateChange })

			callbackInterceptor.recordToolExecution(
				"execute_command",
				{ command: "pytest test_foo.py" },
				"collected 5 items\ntest_foo.py::test_example FAILED\n5 failed",
			)

			expect(onStateChange).toHaveBeenCalled()
			const [oldState, newState] = onStateChange.mock.calls[0]
			expect(oldState.phase).toBe("ANALYZE")
			expect(newState.phase).toBe("MODIFY")
		})
	})

	describe("reset", () => {
		it("should reset state to initial", () => {
			// Modify state
			interceptor.recordToolExecution(
				"execute_command",
				{ command: "pytest test_foo.py" },
				"collected 5 items\ntest_foo.py::test_example FAILED\n5 failed",
			)
			expect(interceptor.getCurrentPhase()).toBe("MODIFY")

			// Reset
			interceptor.reset()

			expect(interceptor.getCurrentPhase()).toBe("ANALYZE")
			expect(interceptor.hasRunTests()).toBe(false)
		})

		it("should reset consecutive apply_diff count", () => {
			for (let i = 0; i < 4; i++) {
				interceptor.recordToolExecution("apply_diff", { path: `file${i}.py`, diff: "..." })
			}

			interceptor.reset()

			// After reset, apply_diff should not be blocked
			const result = interceptor.validateToolUseLegacy("apply_diff", { path: "fileX.py", diff: "..." })
			expect(result).toBeNull()
		})
	})

	describe("serialization", () => {
		it("should serialize and restore state", () => {
			interceptor.recordToolExecution(
				"execute_command",
				{ command: "pytest test_foo.py" },
				"collected 5 items\ntest_foo.py::test_example FAILED\n5 failed",
			)
			interceptor.recordToolExecution("apply_diff", { path: "foo.py", diff: "..." })

			const serialized = interceptor.serialize()

			const newInterceptor = new SWEBenchToolInterceptor()
			newInterceptor.restore(serialized)

			expect(newInterceptor.getCurrentPhase()).toBe(interceptor.getCurrentPhase())
			expect(newInterceptor.hasRunTests()).toBe(interceptor.hasRunTests())
		})

		it("should reset consecutive apply_diff count on restore", () => {
			for (let i = 0; i < 4; i++) {
				interceptor.recordToolExecution("apply_diff", { path: `file${i}.py`, diff: "..." })
			}

			const serialized = interceptor.serialize()
			const newInterceptor = new SWEBenchToolInterceptor()
			newInterceptor.restore(serialized)

			// restore() resets the consecutive counter, so apply_diff should not be blocked
			const result = newInterceptor.validateToolUseLegacy("apply_diff", { path: "fileX.py", diff: "..." })
			expect(result).toBeNull()
		})
	})
})

describe("Global SWE-bench mode functions", () => {
	afterEach(() => {
		deactivateSWEBenchMode()
	})

	describe("activateSWEBenchMode", () => {
		it("should activate SWE-bench mode", () => {
			expect(isSWEBenchModeActive()).toBe(false)

			activateSWEBenchMode()

			expect(isSWEBenchModeActive()).toBe(true)
		})

		it("should return the interceptor", () => {
			const interceptor = activateSWEBenchMode()

			expect(interceptor).toBeInstanceOf(SWEBenchToolInterceptor)
		})
	})

	describe("deactivateSWEBenchMode", () => {
		it("should deactivate SWE-bench mode", () => {
			activateSWEBenchMode()
			expect(isSWEBenchModeActive()).toBe(true)

			deactivateSWEBenchMode()

			expect(isSWEBenchModeActive()).toBe(false)
		})
	})

	describe("validateSWEBenchToolUse", () => {
		it("should return null when mode is not active", () => {
			const result = validateSWEBenchToolUse("apply_diff")
			expect(result).toBeNull()
		})

		it("should validate when mode is active", () => {
			activateSWEBenchMode()

			// Use a tool that's actually blocked (not apply_diff which is now non-blocking)
			const result = validateSWEBenchToolUse("attempt_completion")
			expect(result).not.toBeNull()
		})
	})

	describe("recordSWEBenchToolExecution", () => {
		it("should do nothing when mode is not active", () => {
			// Should not throw
			recordSWEBenchToolExecution("execute_command", { command: "pytest test_foo.py" })
		})

		it("should record when mode is active", () => {
			const interceptor = activateSWEBenchMode()

			recordSWEBenchToolExecution(
				"execute_command",
				{ command: "pytest test_foo.py" },
				"collected 5 items\ntest_foo.py::test_example FAILED\n5 failed",
			)

			expect(interceptor.hasRunTests()).toBe(true)
		})
	})

	describe("getActiveSWEBenchInterceptor", () => {
		it("should return null when mode is not active", () => {
			expect(getActiveSWEBenchInterceptor()).toBeNull()
		})

		it("should return interceptor when mode is active", () => {
			activateSWEBenchMode()

			expect(getActiveSWEBenchInterceptor()).not.toBeNull()
		})
	})

	describe("Path Mapping", () => {
		beforeEach(() => {
			deactivateSWEBenchMode()
		})

		afterEach(() => {
			deactivateSWEBenchMode()
		})

		it("should not apply path mapping when SWE-bench mode is inactive", () => {
			const params = { path: "/testbed/django/urls/resolvers.py" }
			const result = applySWEBenchPathMapping("read_file", params)

			expect(result).toEqual(params) // Should return unchanged
		})

		it("should apply path mapping when SWE-bench mode is active", () => {
			activateSWEBenchMode()

			const params = { path: "/testbed/django/urls/resolvers.py" }
			const result = applySWEBenchPathMapping("read_file", params)

			expect(result).toEqual({ path: "/workspace/repo/django/urls/resolvers.py" })
		})

		it("should map paths in different tools", () => {
			activateSWEBenchMode()

			// Test read_file
			expect(applySWEBenchPathMapping("read_file", { path: "/testbed/file.py" })).toEqual({
				path: "/workspace/repo/file.py",
			})

			// Test apply_diff
			expect(applySWEBenchPathMapping("apply_diff", { path: "/testbed/file.py" })).toEqual({
				path: "/workspace/repo/file.py",
			})

			// Test write_to_file
			expect(applySWEBenchPathMapping("write_to_file", { path: "/testbed/file.py" })).toEqual({
				path: "/workspace/repo/file.py",
			})

			// Test search_and_replace
			expect(applySWEBenchPathMapping("search_and_replace", { path: "/testbed/file.py" })).toEqual({
				path: "/workspace/repo/file.py",
			})

			// Test search_replace
			expect(applySWEBenchPathMapping("search_replace", { file_path: "/testbed/file.py" })).toEqual({
				file_path: "/workspace/repo/file.py",
			})

			// Test list_files
			expect(applySWEBenchPathMapping("list_files", { path: "/testbed" })).toEqual({
				path: "/workspace/repo",
			})

			// Test search_files
			expect(applySWEBenchPathMapping("search_files", { path: "/testbed/src" })).toEqual({
				path: "/workspace/repo/src",
			})
		})

		it("should not map non-testbed paths", () => {
			activateSWEBenchMode()

			const params = { path: "/workspace/repo/file.py" }
			const result = applySWEBenchPathMapping("read_file", params)

			expect(result).toEqual(params) // Should return unchanged
		})

		it("should handle XML args path mapping", () => {
			activateSWEBenchMode()

			const params = {
				args: "<file><path>/testbed/django/urls/resolvers.py</path></file>",
			}
			const result = applySWEBenchPathMapping("read_file", params)

			expect(result?.args).toBe("<file><path>/workspace/repo/django/urls/resolvers.py</path></file>")
		})

		it("should handle XML args path mapping for apply_diff", () => {
			activateSWEBenchMode()

			const params = {
				args: "<file><path>/testbed/django/urls/resolvers.py</path></file>",
			}
			const result = applySWEBenchPathMapping("apply_diff", params)

			expect(result?.args).toBe("<file><path>/workspace/repo/django/urls/resolvers.py</path></file>")
		})

		it("should handle multiple paths in XML args", () => {
			activateSWEBenchMode()

			const params = {
				args: "<files><file><path>/testbed/file1.py</path></file><file><path>/testbed/file2.py</path></file></files>",
			}
			const result = applySWEBenchPathMapping("read_file", params)

			expect(result?.args).toBe(
				"<files><file><path>/workspace/repo/file1.py</path></file><file><path>/workspace/repo/file2.py</path></file></files>",
			)
		})

		it("should handle multiple paths in XML args for apply_diff", () => {
			activateSWEBenchMode()

			const params = {
				args: "<files><file><path>/testbed/file1.py</path></file><file><path>/testbed/file2.py</path></file></files>",
			}
			const result = applySWEBenchPathMapping("apply_diff", params)

			expect(result?.args).toBe(
				"<files><file><path>/workspace/repo/file1.py</path></file><file><path>/workspace/repo/file2.py</path></file></files>",
			)
		})

		it("should not affect execute_command tool", () => {
			activateSWEBenchMode()

			const params = { command: "ls /testbed" }
			const result = applySWEBenchPathMapping("execute_command", params)

			expect(result).toEqual(params) // Should return unchanged for execute_command
		})
	})
})
