import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { validateToolUse } from "../../tools/validateToolUse"
import { activateSWEBenchMode, deactivateSWEBenchMode } from "../tool-interceptor"

describe("SWE-bench Integration", () => {
	beforeEach(() => {
		deactivateSWEBenchMode()
	})

	afterEach(() => {
		deactivateSWEBenchMode()
	})

	it("should integrate path mapping with tool validation", () => {
		activateSWEBenchMode()

		// Test that validateToolUse returns mapped parameters
		const result = validateToolUse(
			"read_file",
			"swebench",
			[],
			{},
			{ path: "/testbed/django/urls/resolvers.py" },
			{},
			[],
		)

		expect(result.mappedParams).toEqual({
			path: "/workspace/repo/django/urls/resolvers.py",
		})
	})

	it("should not apply mapping when SWE-bench mode is inactive", () => {
		// SWE-bench mode is not active

		const result = validateToolUse(
			"read_file",
			"code", // Different mode
			[],
			{},
			{ path: "/testbed/django/urls/resolvers.py" },
			{},
			[],
		)

		expect(result.mappedParams).toEqual({
			path: "/testbed/django/urls/resolvers.py", // Unchanged
		})
	})

	it("should handle complex XML args with path mapping", () => {
		activateSWEBenchMode()

		const xmlArgs = `
			<files>
				<file>
					<path>/testbed/django/urls/resolvers.py</path>
					<line_range>1-50</line_range>
				</file>
				<file>
					<path>/testbed/django/urls/__init__.py</path>
				</file>
			</files>
		`

		const result = validateToolUse("read_file", "swebench", [], {}, { args: xmlArgs }, {}, [])

		expect(result.mappedParams?.args).toContain("/workspace/repo/django/urls/resolvers.py")
		expect(result.mappedParams?.args).toContain("/workspace/repo/django/urls/__init__.py")
	})

	it("should preserve non-testbed paths", () => {
		activateSWEBenchMode()

		const result = validateToolUse("read_file", "swebench", [], {}, { path: "/home/user/file.py" }, {}, [])

		expect(result.mappedParams).toEqual({
			path: "/home/user/file.py", // Unchanged
		})
	})
})
