/**
 * Error Handling and Fallback System for SWE-bench
 *
 * Provides robust error handling, fallback mechanisms, and comprehensive
 * logging throughout the SWE-bench system.
 */

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface ErrorContext {
	readonly component: string
	readonly operation: string
	readonly instanceId?: string
	readonly phase?: string
	readonly additionalData?: Record<string, unknown>
}

export interface FallbackResult<T> {
	readonly success: boolean
	readonly data: T
	readonly error?: string
	readonly fallbackUsed: boolean
	readonly warnings: string[]
}

/**
 * Centralized logging system for SWE-bench components
 */
export class SWEBenchLogger {
	private static instance: SWEBenchLogger
	private logLevel: LogLevel = "info"

	private constructor() {}

	static getInstance(): SWEBenchLogger {
		if (!SWEBenchLogger.instance) {
			SWEBenchLogger.instance = new SWEBenchLogger()
		}
		return SWEBenchLogger.instance
	}

	setLogLevel(level: LogLevel): void {
		this.logLevel = level
	}

	debug(component: string, message: string, data?: unknown): void {
		if (this.shouldLog("debug")) {
			console.debug(`[${component}] ${message}`, data || "")
		}
	}

	info(component: string, message: string, data?: unknown): void {
		if (this.shouldLog("info")) {
			console.log(`[${component}] ${message}`, data || "")
		}
	}

	warn(component: string, message: string, data?: unknown): void {
		if (this.shouldLog("warn")) {
			console.warn(`[${component}] ${message}`, data || "")
		}
	}

	error(component: string, message: string, error?: unknown): void {
		if (this.shouldLog("error")) {
			console.error(`[${component}] ${message}`, error || "")
		}
	}

	logOperation(context: ErrorContext, message: string, data?: unknown): void {
		const prefix = `[${context.component}:${context.operation}]`
		const suffix = context.instanceId ? ` (${context.instanceId})` : ""
		console.log(`${prefix} ${message}${suffix}`, data || "")
	}

	logError(context: ErrorContext, error: unknown, fallbackUsed = false): void {
		const prefix = `[${context.component}:${context.operation}]`
		const suffix = context.instanceId ? ` (${context.instanceId})` : ""
		const fallbackMsg = fallbackUsed ? " - FALLBACK USED" : ""

		console.error(`${prefix} Error${suffix}${fallbackMsg}:`, error)

		if (context.additionalData) {
			console.error(`${prefix} Additional context:`, context.additionalData)
		}
	}

	private shouldLog(level: LogLevel): boolean {
		const levels: Record<LogLevel, number> = {
			debug: 0,
			info: 1,
			warn: 2,
			error: 3,
		}
		return levels[level] >= levels[this.logLevel]
	}
}

/**
 * Error handler with fallback mechanisms
 */
export class SWEBenchErrorHandler {
	private logger = SWEBenchLogger.getInstance()

	/**
	 * Execute operation with error handling and fallback
	 */
	async withFallback<T>(
		operation: () => T | Promise<T>,
		fallback: () => T | Promise<T>,
		context: ErrorContext,
	): Promise<FallbackResult<T>> {
		const warnings: string[] = []

		try {
			this.logger.debug(context.component, `Starting operation: ${context.operation}`)

			const data = await operation()

			this.logger.debug(context.component, `Operation completed successfully: ${context.operation}`)

			return {
				success: true,
				data,
				fallbackUsed: false,
				warnings,
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			warnings.push(`Operation failed: ${errorMessage}`)

			this.logger.logError(context, error, true)

			try {
				this.logger.info(context.component, `Using fallback for operation: ${context.operation}`)

				const fallbackData = await fallback()

				this.logger.info(context.component, `Fallback completed successfully: ${context.operation}`)

				return {
					success: false,
					data: fallbackData,
					error: errorMessage,
					fallbackUsed: true,
					warnings,
				}
			} catch (fallbackError) {
				const fallbackErrorMessage =
					fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
				warnings.push(`Fallback also failed: ${fallbackErrorMessage}`)

				this.logger.error(
					context.component,
					`Fallback failed for operation: ${context.operation}`,
					fallbackError,
				)

				throw new Error(`Both operation and fallback failed: ${errorMessage}, ${fallbackErrorMessage}`)
			}
		}
	}

	/**
	 * Execute operation with retry logic
	 */
	async withRetry<T>(
		operation: () => T | Promise<T>,
		context: ErrorContext,
		maxRetries = 3,
		delayMs = 1000,
	): Promise<T> {
		let lastError: unknown

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				this.logger.debug(
					context.component,
					`Attempt ${attempt}/${maxRetries} for operation: ${context.operation}`,
				)

				const result = await operation()

				if (attempt > 1) {
					this.logger.info(
						context.component,
						`Operation succeeded on attempt ${attempt}: ${context.operation}`,
					)
				}

				return result
			} catch (error) {
				lastError = error

				if (attempt < maxRetries) {
					this.logger.warn(
						context.component,
						`Attempt ${attempt} failed, retrying in ${delayMs}ms: ${context.operation}`,
						error,
					)
					await this.delay(delayMs)
				} else {
					this.logger.error(
						context.component,
						`All ${maxRetries} attempts failed for operation: ${context.operation}`,
						error,
					)
				}
			}
		}

		throw lastError
	}

	/**
	 * Validate input with error handling
	 */
	validateInput<T>(
		input: T,
		validator: (input: T) => boolean,
		context: ErrorContext,
		errorMessage = "Input validation failed",
	): T {
		try {
			if (!validator(input)) {
				throw new Error(errorMessage)
			}
			return input
		} catch (error) {
			this.logger.logError(context, error)
			throw error
		}
	}

	/**
	 * Safe property access with fallback
	 */
	safeAccess<T, K extends keyof T>(obj: T | null | undefined, key: K, fallback: T[K], context: ErrorContext): T[K] {
		try {
			if (obj && obj[key] !== undefined) {
				return obj[key]
			}

			this.logger.warn(context.component, `Property '${String(key)}' not found, using fallback`)
			return fallback
		} catch (error) {
			this.logger.logError(context, error)
			return fallback
		}
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms))
	}
}

/**
 * Specific error types for SWE-bench components
 */
export class RepositoryConfigError extends Error {
	constructor(instanceId: string, message: string, cause?: Error) {
		super(`Repository config error for ${instanceId}: ${message}`)
		this.name = "RepositoryConfigError"
		this.cause = cause
	}
}

export class TemplateRenderError extends Error {
	constructor(templateId: string, message: string, cause?: Error) {
		super(`Template render error for ${templateId}: ${message}`)
		this.name = "TemplateRenderError"
		this.cause = cause
	}
}

export class StateTransitionError extends Error {
	constructor(fromPhase: string, toPhase: string, message: string, cause?: Error) {
		super(`State transition error from ${fromPhase} to ${toPhase}: ${message}`)
		this.name = "StateTransitionError"
		this.cause = cause
	}
}

export class TestAnalysisError extends Error {
	constructor(command: string, message: string, cause?: Error) {
		super(`Test analysis error for command '${command}': ${message}`)
		this.name = "TestAnalysisError"
		this.cause = cause
	}
}

/**
 * Global error handler instance
 */
export const errorHandler = new SWEBenchErrorHandler()

/**
 * Global logger instance
 */
export const logger = SWEBenchLogger.getInstance()

/**
 * Utility functions for common error handling patterns
 */
export function createErrorContext(
	component: string,
	operation: string,
	instanceId?: string,
	phase?: string,
	additionalData?: Record<string, unknown>,
): ErrorContext {
	return {
		component,
		operation,
		instanceId,
		phase,
		additionalData,
	}
}

/**
 * Decorator for automatic error handling and logging
 */
export function withErrorHandling<T extends (...args: any[]) => any>(component: string, operation: string) {
	return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
		const originalMethod = descriptor.value

		descriptor.value = async function (...args: Parameters<T>): Promise<ReturnType<T>> {
			const context = createErrorContext(component, operation)

			try {
				logger.debug(component, `Starting ${operation}`)
				const result = await originalMethod.apply(this, args)
				logger.debug(component, `Completed ${operation}`)
				return result
			} catch (error) {
				logger.logError(context, error)
				throw error
			}
		}

		return descriptor
	}
}

/**
 * Create safe wrapper for functions that might fail
 */
export function createSafeWrapper<T extends (...args: any[]) => any>(
	fn: T,
	fallback: (...args: Parameters<T>) => ReturnType<T>,
	context: ErrorContext,
): T {
	return ((...args: Parameters<T>): ReturnType<T> => {
		try {
			return fn(...args)
		} catch (error) {
			logger.logError(context, error, true)
			return fallback(...args)
		}
	}) as T
}
