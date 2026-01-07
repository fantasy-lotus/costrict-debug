import { describe, it, expect, beforeEach } from "vitest"
import { SWEBenchToolInterceptor } from "../tool-interceptor"

describe("SWEBench Loop Detection", () => {
	let interceptor: SWEBenchToolInterceptor

	beforeEach(() => {
		interceptor = new SWEBenchToolInterceptor()
	})

	it("should detect repeated failed search operations", () => {
		// 模拟连续3次相同的失败搜索
		const params = { regex: "test_nonexistent" }
		const failureOutput = "Found 0 results"

		// 第一次失败 - 应该允许
		let result = interceptor.validateToolUse("search_files", params)
		expect(result).toBeNull()
		interceptor.recordToolExecution("search_files", params, failureOutput)

		// 第二次失败 - 应该允许
		result = interceptor.validateToolUse("search_files", params)
		expect(result).toBeNull()
		interceptor.recordToolExecution("search_files", params, failureOutput)

		// 第三次失败 - 应该允许
		result = interceptor.validateToolUse("search_files", params)
		expect(result).toBeNull()
		interceptor.recordToolExecution("search_files", params, failureOutput)

		// 第四次尝试 - 应该被循环检测阻止
		result = interceptor.validateToolUse("search_files", params)
		expect(result).toContain("LOOP DETECTED")
		expect(result).toContain("attempted the same operation 3 times")
	})

	it("should not detect loop for successful operations", () => {
		const params = { regex: "existing_test" }
		const successOutput = "Found 5 results"

		// 连续成功的操作不应该被检测为循环
		for (let i = 0; i < 5; i++) {
			const result = interceptor.validateToolUse("search_files", params)
			expect(result).toBeNull()
			interceptor.recordToolExecution("search_files", params, successOutput)
		}
	})

	it("should not detect loop for different operations", () => {
		const failureOutput = "Found 0 results"

		// 不同的搜索参数不应该被检测为循环
		interceptor.recordToolExecution("search_files", { regex: "test1" }, failureOutput)
		interceptor.recordToolExecution("search_files", { regex: "test2" }, failureOutput)
		interceptor.recordToolExecution("search_files", { regex: "test3" }, failureOutput)

		const result = interceptor.validateToolUse("search_files", { regex: "test4" })
		expect(result).toBeNull()
	})

	it("should reset loop detection on interceptor reset", () => {
		const params = { regex: "test_reset" }
		const failureOutput = "Found 0 results"

		// 创建循环条件
		for (let i = 0; i < 3; i++) {
			interceptor.recordToolExecution("search_files", params, failureOutput)
		}

		// 验证循环被检测到
		let result = interceptor.validateToolUse("search_files", params)
		expect(result).toContain("LOOP DETECTED")

		// 重置后应该清除历史
		interceptor.reset()
		result = interceptor.validateToolUse("search_files", params)
		expect(result).toBeNull()
	})

	it("should detect loops for execute_command with AttributeError", () => {
		const params = { command: "python -m pytest tests/test_nonexistent.py" }
		const failureOutput = "AttributeError: module has no attribute test_nonexistent"

		// 连续失败的命令执行
		for (let i = 0; i < 3; i++) {
			interceptor.recordToolExecution("execute_command", params, failureOutput)
		}

		const result = interceptor.validateToolUse("execute_command", params)
		expect(result).toContain("LOOP DETECTED")
	})

	it("should NOT detect loop for repeated failed search_files when long outputs vary", () => {
		const params = { regex: "test_nonexistent" }
		const out1 =
			"Found 0 results\n" +
			"Context A - this is long enough to exceed the minimum output length threshold for loop detection. ".repeat(
				2,
			)
		const out2 =
			"Found 0 results\n" +
			"Context B - this is long enough to exceed the minimum output length threshold for loop detection. ".repeat(
				2,
			)
		const out3 =
			"Found 0 results\n" +
			"Context C - this is long enough to exceed the minimum output length threshold for loop detection. ".repeat(
				2,
			)

		interceptor.recordToolExecution("search_files", params, out1)
		interceptor.recordToolExecution("search_files", params, out2)
		interceptor.recordToolExecution("search_files", params, out3)

		const result = interceptor.validateToolUse("search_files", params)
		expect(result).toBeNull()
	})

	it("should treat execute_command outputs with different pid as the same repetition key", () => {
		const params = { command: "pytest tests/test_example.py::TestClass::test_method" }
		const out1 =
			"Command executed in terminal within working directory '/workspace/repo'. Exit code: 1\nOutput:\nError: worker pid 123 failed while collecting"
		const out2 =
			"Command executed in terminal within working directory '/workspace/repo'. Exit code: 1\nOutput:\nError: worker pid 456 failed while collecting"
		const out3 =
			"Command executed in terminal within working directory '/workspace/repo'. Exit code: 1\nOutput:\nError: worker pid 789 failed while collecting"

		interceptor.recordToolExecution("execute_command", params, out1)
		interceptor.recordToolExecution("execute_command", params, out2)
		interceptor.recordToolExecution("execute_command", params, out3)

		const result = interceptor.validateToolUse("execute_command", params)
		expect(result).toContain("LOOP DETECTED")
	})

	it("should NOT treat execute_command with different exit codes as the same repetition key", () => {
		const params = { command: "pytest tests/test_example.py::TestClass::test_method" }
		const out1 =
			"Command executed in terminal within working directory '/workspace/repo'. Exit code: 1\nOutput:\nError: pid 123 failed"
		const out2 =
			"Command executed in terminal within working directory '/workspace/repo'. Exit code: 2\nOutput:\nError: pid 123 failed"
		const out3 =
			"Command executed in terminal within working directory '/workspace/repo'. Exit code: 1\nOutput:\nError: pid 123 failed"

		interceptor.recordToolExecution("execute_command", params, out1)
		interceptor.recordToolExecution("execute_command", params, out2)
		interceptor.recordToolExecution("execute_command", params, out3)

		const result = interceptor.validateToolUse("execute_command", params)
		expect(result).toBeNull()
	})
})
