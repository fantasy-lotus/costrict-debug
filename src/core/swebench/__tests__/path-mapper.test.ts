import { describe, it, expect } from "vitest"
import {
	isSourcePath,
	mapSourceToTarget,
	mapTargetToSource,
	applyPathMapping,
	DEFAULT_SWEBENCH_PATH_MAPPING,
} from "../path-mapper"

describe("SWE-bench Path Mapper", () => {
	describe("isSourcePath", () => {
		it("should detect /testbed paths", () => {
			expect(isSourcePath("/testbed")).toBe(true)
			expect(isSourcePath("/testbed/")).toBe(true)
			expect(isSourcePath("/testbed/django/urls/resolvers.py")).toBe(true)
			expect(isSourcePath("/testbed/repo/src/main.py")).toBe(true)
		})

		it("should not detect non-testbed paths", () => {
			expect(isSourcePath("/workspace/repo/django/urls/resolvers.py")).toBe(false)
			expect(isSourcePath("/home/user/file.py")).toBe(false)
			expect(isSourcePath("relative/path.py")).toBe(false)
			expect(isSourcePath("/testbedx/file.py")).toBe(false) // Similar but not exact
		})

		it("should handle path normalization", () => {
			expect(isSourcePath("/testbed/../testbed/file.py")).toBe(true)
			expect(isSourcePath("/testbed/./file.py")).toBe(true)
			expect(isSourcePath("/testbed//file.py")).toBe(true)
		})
	})

	describe("mapSourceToTarget", () => {
		it("should map /testbed paths to /workspace/repo", () => {
			expect(mapSourceToTarget("/testbed")).toBe("/workspace/repo")
			expect(mapSourceToTarget("/testbed/")).toBe("/workspace/repo")
			expect(mapSourceToTarget("/testbed/django/urls/resolvers.py")).toBe(
				"/workspace/repo/django/urls/resolvers.py",
			)
			expect(mapSourceToTarget("/testbed/repo/src/main.py")).toBe("/workspace/repo/repo/src/main.py")
		})

		it("should not map non-testbed paths", () => {
			const paths = ["/workspace/repo/file.py", "/home/user/file.py", "relative/path.py"]
			paths.forEach((path) => {
				expect(mapSourceToTarget(path)).toBe(path)
			})
		})

		it("should handle path normalization", () => {
			expect(mapSourceToTarget("/testbed/../testbed/file.py")).toBe("/workspace/repo/file.py")
			expect(mapSourceToTarget("/testbed/./file.py")).toBe("/workspace/repo/file.py")
			expect(mapSourceToTarget("/testbed//file.py")).toBe("/workspace/repo/file.py")
		})

		it("should work with custom config", () => {
			const config = { sourcePrefix: "/custom/src", targetPrefix: "/custom/dst" }
			expect(mapSourceToTarget("/custom/src/file.py", config)).toBe("/custom/dst/file.py")
			expect(mapSourceToTarget("/testbed/file.py", config)).toBe("/testbed/file.py") // No mapping
		})
	})

	describe("mapTargetToSource", () => {
		it("should map /workspace/repo paths back to /testbed", () => {
			expect(mapTargetToSource("/workspace/repo")).toBe("/testbed")
			expect(mapTargetToSource("/workspace/repo/")).toBe("/testbed")
			expect(mapTargetToSource("/workspace/repo/django/urls/resolvers.py")).toBe(
				"/testbed/django/urls/resolvers.py",
			)
		})

		it("should not map non-workspace paths", () => {
			const paths = ["/testbed/file.py", "/home/user/file.py", "relative/path.py"]
			paths.forEach((path) => {
				expect(mapTargetToSource(path)).toBe(path)
			})
		})
	})

	describe("applyPathMapping", () => {
		it("should apply mapping when SWE-bench mode is active", () => {
			expect(applyPathMapping("/testbed/file.py", true)).toBe("/workspace/repo/file.py")
			expect(applyPathMapping("/testbed/django/urls/resolvers.py", true)).toBe(
				"/workspace/repo/django/urls/resolvers.py",
			)
		})

		it("should not apply mapping when SWE-bench mode is inactive", () => {
			expect(applyPathMapping("/testbed/file.py", false)).toBe("/testbed/file.py")
			expect(applyPathMapping("/workspace/repo/file.py", false)).toBe("/workspace/repo/file.py")
		})

		it("should not map non-testbed paths even in SWE-bench mode", () => {
			expect(applyPathMapping("/workspace/repo/file.py", true)).toBe("/workspace/repo/file.py")
			expect(applyPathMapping("/home/user/file.py", true)).toBe("/home/user/file.py")
		})
	})

	describe("edge cases", () => {
		it("should handle empty and invalid paths", () => {
			expect(mapSourceToTarget("")).toBe("")
			expect(mapTargetToSource("")).toBe("")
			expect(isSourcePath("")).toBe(false)
		})

		it("should handle root paths", () => {
			expect(mapSourceToTarget("/")).toBe("/")
			expect(isSourcePath("/")).toBe(false)
		})

		it("should handle relative paths", () => {
			expect(mapSourceToTarget("testbed/file.py")).toBe("testbed/file.py")
			expect(isSourcePath("testbed/file.py")).toBe(false)
		})
	})
})
