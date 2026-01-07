/**
 * Repository Configuration System
 *
 * Extends the existing RepoTestGuidance with additional configuration
 * for flexible exploration and enhanced test command analysis.
 *
 * Includes robust error handling and fallback mechanisms.
 */

import type { RepoTestGuidance } from "./instance-prompts"
import { getRepoTestGuidance } from "./instance-prompts"

/**
 * Configuration loading result with error information
 */
export interface ConfigurationResult<T> {
	readonly success: boolean
	readonly data?: T
	readonly error?: string
	readonly fallbackUsed: boolean
	readonly warnings: string[]
}

/**
 * Extended repository configuration with flexible exploration settings
 */
export interface RepositoryConfig extends RepoTestGuidance {
	/** Minimum read calls required before allowing modifications */
	readonly minReadCalls: number
	/** Minimum test calls required before allowing modifications */
	readonly minTestCalls: number
	/** Whether to enforce strict exploration requirements */
	readonly strictExploration: boolean
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG = {
	minReadCalls: 10,
	minTestCalls: 1,
	strictExploration: false, // Flexible by default
}

/**
 * Get repository configuration for an instance with error handling
 * Extends existing RepoTestGuidance with configuration defaults
 */
export function getRepositoryConfig(instanceId: string): RepositoryConfig {
	try {
		console.log(`[RepositoryConfig] Loading configuration for instance: ${instanceId}`)

		if (!instanceId || typeof instanceId !== "string") {
			console.warn(`[RepositoryConfig] Invalid instance ID: ${instanceId}, using fallback configuration`)
			return createFallbackConfig("*")
		}

		const baseGuidance = getRepoTestGuidance(instanceId)

		if (!baseGuidance) {
			console.warn(
				`[RepositoryConfig] No guidance found for instance: ${instanceId}, using fallback configuration`,
			)
			return createFallbackConfig(instanceId)
		}

		const config = {
			...baseGuidance,
			...DEFAULT_CONFIG,
		}

		console.log(
			`[RepositoryConfig] Successfully loaded configuration for ${instanceId} (type: ${config.projectType})`,
		)
		return config
	} catch (error) {
		console.error(`[RepositoryConfig] Error loading configuration for ${instanceId}:`, error)
		console.log(`[RepositoryConfig] Using fallback configuration for ${instanceId}`)
		return createFallbackConfig(instanceId)
	}
}

/**
 * Get repository configuration with detailed error information
 */
export function getRepositoryConfigSafe(instanceId: string): ConfigurationResult<RepositoryConfig> {
	const warnings: string[] = []

	try {
		console.log(`[RepositoryConfig] Safe loading configuration for instance: ${instanceId}`)

		if (!instanceId || typeof instanceId !== "string") {
			const warning = `Invalid instance ID: ${instanceId}`
			console.warn(`[RepositoryConfig] ${warning}`)
			warnings.push(warning)

			return {
				success: false,
				data: createFallbackConfig("*"),
				error: "Invalid instance ID",
				fallbackUsed: true,
				warnings,
			}
		}

		const baseGuidance = getRepoTestGuidance(instanceId)

		if (!baseGuidance) {
			const warning = `No specific guidance found for instance: ${instanceId}`
			console.warn(`[RepositoryConfig] ${warning}`)
			warnings.push(warning)

			return {
				success: false,
				data: createFallbackConfig(instanceId),
				error: "No repository-specific guidance available",
				fallbackUsed: true,
				warnings,
			}
		}

		// Validate the guidance data
		const validationResult = validateGuidanceData(baseGuidance)
		if (!validationResult.valid) {
			warnings.push(...validationResult.warnings)
			console.warn(`[RepositoryConfig] Validation warnings for ${instanceId}:`, validationResult.warnings)
		}

		const config = {
			...baseGuidance,
			...DEFAULT_CONFIG,
		}

		console.log(
			`[RepositoryConfig] Successfully loaded configuration for ${instanceId} (type: ${config.projectType})`,
		)

		return {
			success: true,
			data: config,
			fallbackUsed: false,
			warnings,
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		console.error(`[RepositoryConfig] Error loading configuration for ${instanceId}:`, error)

		return {
			success: false,
			data: createFallbackConfig(instanceId),
			error: errorMessage,
			fallbackUsed: true,
			warnings: [...warnings, `Configuration loading failed: ${errorMessage}`],
		}
	}
}

/**
 * Create fallback configuration when repository-specific config is unavailable
 */
function createFallbackConfig(instanceId: string): RepositoryConfig {
	console.log(`[RepositoryConfig] Creating fallback configuration for ${instanceId}`)

	return {
		repo: instanceId,
		projectType: "custom",
		testRunner: "auto-detect",
		testDiscovery: `Generic test discovery strategy:
   1. Check README.md for testing instructions
   2. Look for test runner scripts: runtests.py, test.py, manage.py
   3. Check for pytest.ini, tox.ini, pyproject.toml
   4. Try common patterns: python -m pytest, python -m unittest`,
		testPatterns: ["test_*.py", "*_test.py", "tests/", "test/"],
		failToPassGuidance: `Generic FAIL_TO_PASS test strategy:
   • Search for test method names in codebase
   • Try multiple test runners if one fails
   • Start broad, then narrow down to specific tests
   • Check project documentation for testing conventions`,
		examples: ["python -m pytest tests/", "python -m unittest discover", "./runtests.py", "python test.py"],
		...DEFAULT_CONFIG,
	}
}

/**
 * Validate guidance data for completeness and correctness
 */
function validateGuidanceData(guidance: RepoTestGuidance): {
	valid: boolean
	warnings: string[]
} {
	const warnings: string[] = []

	if (!guidance.repo) {
		warnings.push("Missing repository identifier")
	}

	if (!guidance.projectType) {
		warnings.push("Missing project type")
	}

	if (!guidance.testRunner) {
		warnings.push("Missing test runner configuration")
	}

	if (!guidance.examples || guidance.examples.length === 0) {
		warnings.push("No example commands provided")
	}

	if (!guidance.testPatterns || guidance.testPatterns.length === 0) {
		warnings.push("No test patterns defined")
	}

	return {
		valid: warnings.length === 0,
		warnings,
	}
}

/**
 * Check if understanding is sufficient for modifications
 */
export function checkUnderstandingRequirement(
	readCallsCount: number,
	testCallsCount: number,
	config: RepositoryConfig,
): {
	sufficient: boolean
	readCallsCount: number
	testCallsCount: number
	requiredCalls: number
	recommendation: string
} {
	const sufficient = readCallsCount >= config.minReadCalls && testCallsCount >= config.minTestCalls
	const requiredCalls = config.minReadCalls + config.minTestCalls

	let recommendation = ""
	if (!sufficient) {
		const needsRead = readCallsCount < config.minReadCalls
		const needsTest = testCallsCount < config.minTestCalls

		if (needsRead && needsTest) {
			recommendation = `Need ${config.minReadCalls - readCallsCount} more read calls and ${config.minTestCalls - testCallsCount} more test calls to build sufficient understanding`
		} else if (needsRead) {
			recommendation = `Need ${config.minReadCalls - readCallsCount} more read calls to understand the codebase better`
		} else if (needsTest) {
			recommendation = `Need ${config.minTestCalls - testCallsCount} more test calls to understand test behavior`
		}
	}

	return {
		sufficient,
		readCallsCount,
		testCallsCount,
		requiredCalls,
		recommendation,
	}
}
