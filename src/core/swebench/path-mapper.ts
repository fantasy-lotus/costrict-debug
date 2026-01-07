/**
 * SWE-bench Path Mapper
 *
 * Maps /testbed paths to /workspace/repo paths for SWE-bench mode.
 * This allows the agent to use paths from test error output (/testbed/...)
 * while actually working in the shared volume (/workspace/repo/...).
 */

import path from "path"

/**
 * SWE-bench path mapping configuration
 */
export interface PathMappingConfig {
	/** Source path prefix (e.g., "/testbed") */
	sourcePrefix: string
	/** Target path prefix (e.g., "/workspace/repo") */
	targetPrefix: string
}

/**
 * Default path mapping for SWE-bench
 */
export const DEFAULT_SWEBENCH_PATH_MAPPING: PathMappingConfig = {
	sourcePrefix: "/testbed",
	targetPrefix: "/workspace/repo",
}

/**
 * Check if a path starts with the source prefix
 */
export function isSourcePath(filePath: string, config: PathMappingConfig = DEFAULT_SWEBENCH_PATH_MAPPING): boolean {
	const normalized = path.posix.normalize(filePath)
	return normalized.startsWith(config.sourcePrefix + "/") || normalized === config.sourcePrefix
}

/**
 * Map a source path to target path
 * @param filePath - The path to map (e.g., "/testbed/django/urls/resolvers.py")
 * @param config - Path mapping configuration
 * @returns Mapped path (e.g., "/workspace/repo/django/urls/resolvers.py")
 */
export function mapSourceToTarget(filePath: string, config: PathMappingConfig = DEFAULT_SWEBENCH_PATH_MAPPING): string {
	const normalized = path.posix.normalize(filePath)

	// If path starts with source prefix, replace it with target prefix
	if (normalized.startsWith(config.sourcePrefix + "/")) {
		const relativePath = normalized.slice(config.sourcePrefix.length + 1)
		return path.posix.join(config.targetPrefix, relativePath)
	}

	// If path is exactly the source prefix, return target prefix
	if (normalized === config.sourcePrefix) {
		return config.targetPrefix
	}

	// Otherwise, return unchanged
	return filePath
}

/**
 * Map a target path back to source path (for display purposes)
 * @param filePath - The path to map (e.g., "/workspace/repo/django/urls/resolvers.py")
 * @param config - Path mapping configuration
 * @returns Mapped path (e.g., "/testbed/django/urls/resolvers.py")
 */
export function mapTargetToSource(filePath: string, config: PathMappingConfig = DEFAULT_SWEBENCH_PATH_MAPPING): string {
	const normalized = path.posix.normalize(filePath)

	// If path starts with target prefix, replace it with source prefix
	if (normalized.startsWith(config.targetPrefix + "/")) {
		const relativePath = normalized.slice(config.targetPrefix.length + 1)
		return path.posix.join(config.sourcePrefix, relativePath)
	}

	// If path is exactly the target prefix, return source prefix
	if (normalized === config.targetPrefix) {
		return config.sourcePrefix
	}

	// Otherwise, return unchanged
	return filePath
}

/**
 * Apply path mapping to a file path if SWE-bench mode is active
 * @param filePath - The original file path
 * @param isSWEBenchMode - Whether SWE-bench mode is active
 * @param config - Path mapping configuration
 * @returns Mapped path if in SWE-bench mode and path matches, otherwise original path
 */
export function applyPathMapping(
	filePath: string,
	isSWEBenchMode: boolean,
	config: PathMappingConfig = DEFAULT_SWEBENCH_PATH_MAPPING,
): string {
	if (!isSWEBenchMode) {
		return filePath
	}

	return mapSourceToTarget(filePath, config)
}
