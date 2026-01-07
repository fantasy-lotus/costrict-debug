import { describe, it, expect } from "vitest"
import {
	getInstanceTestGuidance,
	getRepoTestGuidance,
	generateInstanceTestDiscoveryGuidance,
	getRecommendedTestCommand,
	extractLikelyTestNames,
} from "../instance-prompts"

describe("Repository-Specific Prompt System", () => {
	describe("getRepoTestGuidance", () => {
		it("should return Django-specific guidance for django instances", () => {
			const guidance = getRepoTestGuidance("django__django-12345")

			expect(guidance.projectType).toBe("django")
			expect(guidance.testRunner).toContain("./tests/runtests.py")
			expect(guidance.testPatterns).toContain("admin")
		})

		it("should return Astropy-specific guidance for astropy instances", () => {
			const guidance = getRepoTestGuidance("astropy__astropy-1234")

			expect(guidance.projectType).toBe("pytest")
			expect(guidance.testRunner).toBe("pytest -rA --tb=long")
			expect(guidance.testPatterns).toContain("astropy/*/tests/")
		})

		it("should return Scikit-learn guidance for sklearn instances", () => {
			const guidance = getRepoTestGuidance("scikit-learn__scikit-learn-5678")

			expect(guidance.projectType).toBe("pytest")
			expect(guidance.testRunner).toBe("python -m pytest --showlocals --durations=20")
			expect(guidance.testPatterns).toContain("sklearn/*/tests/")
		})

		it("should return generic guidance for unknown repositories", () => {
			const guidance = getRepoTestGuidance("unknown__project-123")

			expect(guidance.projectType).toBe("custom")
			expect(guidance.testRunner).toBe("auto-detect")
			expect(guidance.repo).toBe("*")
		})
	})

	describe("getInstanceTestGuidance (legacy)", () => {
		it("should work as backward compatibility wrapper", () => {
			const guidance = getInstanceTestGuidance("django__django-12345")

			expect(guidance.projectType).toBe("django")
			expect(guidance.testRunner).toContain("./tests/runtests.py")
		})
	})

	describe("generateInstanceTestDiscoveryGuidance", () => {
		it("should generate Django-specific guidance", () => {
			const guidance = generateInstanceTestDiscoveryGuidance("django__django-12325")

			expect(guidance).toContain("REPOSITORY-SPECIFIC TEST DISCOVERY")
			expect(guidance).toContain("django__django-12325")
			expect(guidance).toContain("REPOSITORY: django/django")
			expect(guidance).toContain("PROJECT TYPE: DJANGO")
			expect(guidance).toContain("./tests/runtests.py")
			expect(guidance).toContain("admin")
		})

		it("should generate Astropy-specific guidance", () => {
			const guidance = generateInstanceTestDiscoveryGuidance("astropy__astropy-1234")

			expect(guidance).toContain("REPOSITORY: astropy/astropy")
			expect(guidance).toContain("PROJECT TYPE: PYTEST")
			expect(guidance).toContain("pytest -rA --tb=long")
			expect(guidance).toContain("astropy/*/tests/")
		})

		it("should include warning about not installing dependencies", () => {
			const guidance = generateInstanceTestDiscoveryGuidance("any__project-123")

			expect(guidance).toContain("Do NOT install pytest or other dependencies")
		})
	})

	describe("getRecommendedTestCommand", () => {
		it("should return Django command for Django instance", () => {
			const command = getRecommendedTestCommand("django__django-12325")

			expect(command).toContain("./tests/runtests.py")
			expect(command).toContain("--verbosity 2")
			expect(command).toContain("--settings=test_sqlite")
		})

		it("should return pytest command for Astropy instance", () => {
			const command = getRecommendedTestCommand("astropy__astropy-1234")

			expect(command).toContain("pytest -rA --tb=long astropy")
		})

		it("should return SymPy command for SymPy instance", () => {
			const command = getRecommendedTestCommand("sympy__sympy-5678")

			expect(command).toContain("bin/test -C --verbose")
		})

		it("should return null for empty instance ID", () => {
			const command = getRecommendedTestCommand("")

			expect(command).toBeNull()
		})
	})

	describe("extractLikelyTestNames", () => {
		it("should extract test names from Django problem text", () => {
			const problemText = "The test_clash_parent_link and test_onetoone_with_parent_model tests are failing"
			const testNames = extractLikelyTestNames("django__django-12325", problemText)

			expect(testNames).toContain("test_clash_parent_link")
			expect(testNames).toContain("test_onetoone_with_parent_model")
		})

		it("should return empty array for non-Django instances", () => {
			const testNames = extractLikelyTestNames("astropy__astropy-1234", "some problem text")

			expect(testNames).toEqual([])
		})

		it("should return empty array when no problem text provided", () => {
			const testNames = extractLikelyTestNames("django__django-12325")

			expect(testNames).toEqual([])
		})
	})

	describe("Repository extraction", () => {
		it("should correctly extract repository names from instance IDs", () => {
			const djangoGuidance = getRepoTestGuidance("django__django-12325")
			const astropyGuidance = getRepoTestGuidance("astropy__astropy-1234")
			const sklearnGuidance = getRepoTestGuidance("scikit-learn__scikit-learn-5678")

			expect(djangoGuidance.repo).toBe("django/django")
			expect(astropyGuidance.repo).toBe("astropy/astropy")
			expect(sklearnGuidance.repo).toBe("scikit-learn/scikit-learn")
		})

		it("should handle malformed instance IDs gracefully", () => {
			const guidance = getRepoTestGuidance("malformed-instance-id")

			// Should fall back to generic guidance
			expect(guidance.projectType).toBe("custom")
			expect(guidance.repo).toBe("*")
		})
	})

	describe("Official SWE-bench verified repositories", () => {
		it("should support all SWE-bench verified repositories", () => {
			// Only test repositories that are actually in SWE-bench verified dataset
			const repos = [
				"django__django-12325",
				"astropy__astropy-1234",
				"scikit-learn__scikit-learn-5678",
				"matplotlib__matplotlib-9999",
				"sympy__sympy-1111",
				"sphinx-doc__sphinx-2222",
				"flask__flask-3333",
				"psf__requests-4444",
				"mwaskom__seaborn-6666",
				"pydata__xarray-7777",
				"pylint-dev__pylint-1010",
				"pytest-dev__pytest-1111",
			]

			repos.forEach((instanceId) => {
				const guidance = getRepoTestGuidance(instanceId)
				// Should not fall back to generic guidance for known repos
				expect(guidance.repo).not.toBe("*")
				expect(guidance.testRunner).not.toBe("auto-detect")
			})
		})

		it("should fall back to generic guidance for non-verified repositories", () => {
			const nonVerifiedRepos = [
				"marshmallow-code__marshmallow-5555",
				"pydicom__pydicom-8888",
				"pylint-dev__astroid-9999",
				"unknown__repository-123",
			]

			nonVerifiedRepos.forEach((instanceId) => {
				const guidance = getRepoTestGuidance(instanceId)
				// Should fall back to generic guidance for non-verified repos
				expect(guidance.repo).toBe("*")
				expect(guidance.testRunner).toBe("auto-detect")
			})
		})
	})
})
