// npx vitest run src/core/swebench/__tests__/test-file-blocking.test.ts

import { describe, it, expect, beforeEach } from "vitest"
import { SWEBenchToolInterceptor } from "../tool-interceptor"
import type { ToolName } from "@roo-code/types"

describe("SWEBench Simplified Workflow", () => {
	let interceptor: SWEBenchToolInterceptor

	beforeEach(() => {
		interceptor = new SWEBenchToolInterceptor({ strictMode: true })
	})

	describe("First modification attempt guidance", () => {
		const testFilePaths = [
			"test_example.py",
			"tests/test_models.py",
			"src/tests/test_utils.py",
			"src/models.py",
			"lib/utils.js",
			"app/controllers/api.py",
		]

		it("should provide non-blocking guidance on first modification attempt in ANALYZE phase", () => {
			testFilePaths.forEach((path) => {
				const result = interceptor.validateToolUse("apply_diff", { path })
				// Changed to non-blocking - should return null but log guidance
				expect(result).toBeNull()
			})
		})

		it("should allow second modification attempt without any issues", () => {
			// First attempt should be allowed (non-blocking)
			const firstResult = interceptor.validateToolUse("apply_diff", { path: "src/models.py" })
			expect(firstResult).toBeNull()

			// Record the first attempt
			interceptor.recordToolExecution("apply_diff", { path: "src/models.py" }, "Applied diff successfully")

			// Second attempt should also be allowed
			const secondResult = interceptor.validateToolUse("apply_diff", { path: "src/utils.py" })
			expect(secondResult).toBeNull()
		})

		it("should allow modification after running tests", () => {
			// Run tests first
			interceptor.recordToolExecution(
				"execute_command",
				{ command: "pytest tests/" },
				"FAILED: 2 failed, 3 passed",
			)

			// Should allow modification without any issues after tests
			const result = interceptor.validateToolUse("apply_diff", { path: "src/models.py" })
			expect(result).toBeNull()
		})
	})

	describe("Test file modifications are now allowed", () => {
		const testFilePaths = [
			"test_example.py",
			"tests/test_models.py",
			"src/tests/test_utils.py",
			"example_test.py",
			"tests/integration/test_api.py",
			"__tests__/component.test.js",
			"spec/models_spec.rb",
		]

		beforeEach(() => {
			// Move to MODIFY phase to avoid first-attempt warning
			interceptor.recordToolExecution(
				"execute_command",
				{ command: "pytest tests/" },
				"FAILED: 2 failed, 3 passed",
			)
		})

		it("should allow modification of test files with apply_diff", () => {
			testFilePaths.forEach((path) => {
				const result = interceptor.validateToolUse("apply_diff", { path })
				expect(result).toBeNull() // Should be allowed
			})
		})

		it("should allow write_to_file in MODIFY phase", () => {
			testFilePaths.forEach((path) => {
				const result = interceptor.validateToolUse("write_to_file", { path, content: "print('ok')\n" })
				expect(result).toBeNull() // Allowed in MODIFY/VERIFY phases
			})
		})

		it("should still block search_and_replace (not allowed in MODIFY phase)", () => {
			testFilePaths.forEach((path) => {
				const result = interceptor.validateToolUse("search_and_replace", { path })
				expect(result).toContain("not allowed") // Blocked by phase rules
			})
		})
	})

	describe("Non-modification tools", () => {
		const testFilePaths = ["test_example.py", "tests/test_models.py", "src/tests/test_utils.py"]

		it("should allow reading test files", () => {
			testFilePaths.forEach((path) => {
				const result = interceptor.validateToolUse("read_file", { path })
				expect(result).toBeNull()
			})
		})

		it("should allow searching in test files", () => {
			const result = interceptor.validateToolUse("search_files", {
				regex: "test_function",
				file_pattern: "test_*.py",
			})
			expect(result).toBeNull()
		})

		it("should allow listing test directories", () => {
			const result = interceptor.validateToolUse("list_files", { path: "tests/" })
			expect(result).toBeNull()
		})
	})

	describe("Edge cases", () => {
		it("should handle missing path parameter", () => {
			const result = interceptor.validateToolUse("apply_diff", {})
			// Changed to non-blocking - should return null
			expect(result).toBeNull()
		})

		it("should handle non-string path parameter", () => {
			const result = interceptor.validateToolUse("apply_diff", { path: 123 })
			// Changed to non-blocking - should return null
			expect(result).toBeNull()
		})

		it("should handle undefined params", () => {
			const result = interceptor.validateToolUse("apply_diff", undefined)
			// Changed to non-blocking - should return null
			expect(result).toBeNull()
		})
	})
})
