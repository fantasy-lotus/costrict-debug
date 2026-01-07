import { describe, it, expect } from "vitest"
import { isTestFile } from "../state-machine"

describe("Test File Detection", () => {
	describe("isTestFile", () => {
		it("should detect Python test files", () => {
			expect(isTestFile("test_example.py")).toBe(true)
			expect(isTestFile("example_test.py")).toBe(true)
			expect(isTestFile("tests/test_module.py")).toBe(true)
			expect(isTestFile("src/tests/test_utils.py")).toBe(true)
			expect(isTestFile("module.py")).toBe(false)
		})

		it("should detect JavaScript/TypeScript test files", () => {
			expect(isTestFile("example.test.js")).toBe(true)
			expect(isTestFile("example.spec.ts")).toBe(true)
			expect(isTestFile("__tests__/example.js")).toBe(true)
			expect(isTestFile("tests/example.tsx")).toBe(true)
			expect(isTestFile("src/component.jsx")).toBe(false)
		})

		it("should detect Java test files", () => {
			expect(isTestFile("ExampleTest.java")).toBe(true)
			expect(isTestFile("ExampleTests.java")).toBe(true)
			expect(isTestFile("test/Example.java")).toBe(true)
			expect(isTestFile("Example.java")).toBe(false)
		})

		it("should detect Go test files", () => {
			expect(isTestFile("example_test.go")).toBe(true)
			expect(isTestFile("example.go")).toBe(false)
		})

		it("should detect C/C++ test files", () => {
			expect(isTestFile("test_example.c")).toBe(true)
			expect(isTestFile("example_test.cpp")).toBe(true)
			expect(isTestFile("example.c")).toBe(false)
		})

		it("should detect Ruby test files", () => {
			expect(isTestFile("example_test.rb")).toBe(true)
			expect(isTestFile("test_example.rb")).toBe(true)
			expect(isTestFile("spec/example.rb")).toBe(true)
			expect(isTestFile("example.rb")).toBe(false)
		})

		it("should detect general test directory patterns", () => {
			expect(isTestFile("tests/anything.py")).toBe(true)
			expect(isTestFile("test/anything.js")).toBe(true)
			expect(isTestFile("__tests__/anything.ts")).toBe(true)
			expect(isTestFile("spec/anything.rb")).toBe(true)
			expect(isTestFile("specs/anything.py")).toBe(true)
			expect(isTestFile("src/anything.py")).toBe(false)
		})

		it("should be case insensitive", () => {
			expect(isTestFile("TEST_EXAMPLE.PY")).toBe(true)
			expect(isTestFile("Example.TEST.JS")).toBe(true)
			expect(isTestFile("TESTS/Example.py")).toBe(true)
		})
	})
})
