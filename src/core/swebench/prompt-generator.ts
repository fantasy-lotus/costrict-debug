/**
 * SWE-bench Modular Prompt System
 *
 * Provides template-based prompt generation with repository-specific customization
 * and variable substitution for dynamic content generation.
 *
 * Follows Occam's Razor: Keep it simple, extend existing instance-prompts system.
 */

import type { SWEBenchPhase, SWEBenchState } from "./state-machine"
import type { RepositoryConfig } from "./repository-config"
import { getRepositoryConfig } from "./repository-config"
import { generateInstanceTestDiscoveryGuidance } from "./instance-prompts"

/**
 * Template variable context for prompt generation
 */
export interface PromptContext {
	/** Current state machine state */
	state: SWEBenchState
	/** Repository configuration */
	repositoryConfig: RepositoryConfig
	/** Instance ID for instance-specific guidance */
	instanceId?: string
	/** Additional dynamic variables */
	variables?: Record<string, string | number | boolean>
}

/**
 * Prompt template with variable substitution support
 */
export interface PromptTemplate {
	/** Template ID for identification */
	id: string
	/** Template content with {{variable}} placeholders */
	content: string
	/** Required variables for this template */
	requiredVariables?: string[]
	/** Optional variables with default values */
	defaultVariables?: Record<string, string | number | boolean>
}

/**
 * Repository-specific prompt overrides
 */
export interface RepositoryPromptOverrides {
	/** Repository identifier */
	repository: string
	/** Phase-specific template overrides */
	phaseOverrides?: Partial<Record<SWEBenchPhase, PromptTemplate>>
	/** Additional repository-specific templates */
	customTemplates?: Record<string, PromptTemplate>
}

/**
 * Prompt generation result
 */
export interface GeneratedPrompt {
	/** Generated prompt content */
	content: string
	/** Template used for generation */
	templateId: string
	/** Variables used in generation */
	variables: Record<string, unknown>
	/** Repository configuration used */
	repository: string
}

/**
 * Default prompt templates for each phase
 */
const DEFAULT_TEMPLATES: Record<SWEBenchPhase, PromptTemplate> = {
	ANALYZE: {
		id: "analyze-default",
		content: `🔄 CURRENT PHASE: {{phase}}
📋 {{description}}

## RR → PLAN → ACTION (Keep it short)

## MCP + Debug requirements (MUST FOLLOW)
- MCP server name: use \`sequential-thinking\` (with a hyphen). Do NOT call \`sequentialthinking\` (it is not configured).
- If the failure cause is unclear, add minimal debug instrumentation (logs/prints/assertions) in production code to confirm/deny hypotheses.
- Always verify with FAIL_TO_PASS (then PASS_TO_PASS) after making changes. Do NOT modify/create tests.

### RR (Recon / Reproduce)
1. Recon (fault localization)
   - Identify Top-3~5 suspicious files using search_files / list_files.
   - For each file, use read_file to extract element-level targets (classes/functions) to inspect/modify.
2. Reproduce (fast failing signal)
   - Prefer running FAIL_TO_PASS with execute_command.
   - If FAIL_TO_PASS is slow/hard, first create a minimal repro signal:
     - write reproduce_issue.py ("Issue reproduced" / "Issue resolved"), or
     - run the smallest pytest nodeid you can identify.

### PLAN
- Write a 3-6 step plan; each step must be an explicit tool action or shell command.
- Before executing, use MCP sequential-thinking to rank hypotheses and pick the next minimal verifiable step (totalThoughts: 3; 5+ if multiple modules).

### ACTION
- Execute exactly one next step from your plan (one command, one read_file, or one minimal patch).

⚠️ Phase constraint:
- Do NOT edit code until you have a failing signal from tests or a repro script.

Status: hasRunTests={{hasRunTests}}, testsRunCount={{testsRunCount}}`,
		requiredVariables: ["phase", "description", "testsRunCount", "hasRunTests"],
		defaultVariables: {
			hasInstanceGuidance: false,
			instanceGuidance: "",
			showProjectExploration: false,
			showTestDiscovery: false,
			readmeRead: false,
			testStructureExplored: false,
			targetTestsLocated: false,
			projectExplorationComplete: false,
			failToPassTestNames: "",
		},
	},

	MODIFY: {
		id: "modify-default",
		content: `🔄 CURRENT PHASE: {{phase}}
📋 {{description}}

## RR → PLAN → ACTION

## MCP + Debug requirements (MUST FOLLOW)
- MCP server name: use \`sequential-thinking\` (with a hyphen). Do NOT call \`sequentialthinking\` (it is not configured).
- If the failure cause is unclear, add minimal debug instrumentation (logs/prints/assertions) in production code to confirm/deny hypotheses.
- Always verify with FAIL_TO_PASS (then PASS_TO_PASS) after making changes. Do NOT modify/create tests.

### RR
- Restate the failing signal and the most likely root cause (1-2 sentences).

### PLAN
- Plan 3-6 steps: smallest viable change first.
- Specify exactly which file/function you will change and how you will verify.
- Before patching, use MCP sequential-thinking to choose the smallest viable change + the exact verification command (totalThoughts: 3; 5+ if failures persist).

### ACTION
- Apply one minimal patch.
- Immediately follow with the next verification command.

⚠️ Phase constraints:
- Keep changes minimal; avoid refactors.
- Prefer apply_diff for edits; use write_to_file only for small helper scripts.

📊 modificationCount={{modificationCount}}
{{#if modifiedFiles}}
📁 modifiedFiles={{modifiedFiles}}
{{/if}}`,
		requiredVariables: ["phase", "description", "modificationCount"],
		defaultVariables: {
			modifiedFiles: "",
		},
	},

	VERIFY: {
		id: "verify-default",
		content: `🔄 CURRENT PHASE: {{phase}}
📋 {{description}}

## RR → PLAN → ACTION

## MCP + Debug requirements (MUST FOLLOW)
- MCP server name: use \`sequential-thinking\` (with a hyphen). Do NOT call \`sequentialthinking\` (it is not configured).
- If verification is unclear/flaky, add minimal debug instrumentation (logs/prints/assertions) in production code to confirm expected behavior.
- Always verify with FAIL_TO_PASS (then PASS_TO_PASS). Do NOT modify/create tests.

### RR
- Summarize what changed and what failure you expect to be fixed.

### PLAN
- Re-run the key FAIL_TO_PASS command(s) you used before.
- Add minimal regression coverage if available.
- Use MCP sequential-thinking to define a tight verification sequence and the fallback if tests still fail (totalThoughts: 3; 5+ if repeated failures).

### ACTION
- Execute the next verification command now.

Optional (no new installs): python -m py_compile <modified_files...> / python -m compileall -q .

If verified, call attempt_completion.

testsPassedAfterModify={{testsPassedAfterModify}}
{{#if modifiedFiles}}
modifiedFiles={{modifiedFiles}}
{{/if}}`,
		requiredVariables: ["phase", "description", "testsPassedAfterModify"],
		defaultVariables: {
			modifiedFiles: "",
		},
	},
}

/**
 * Template rendering result with error information
 */
export interface TemplateRenderResult {
	readonly success: boolean
	readonly content: string
	readonly errors: string[]
	readonly warnings: string[]
	readonly fallbackUsed: boolean
}

/**
 * Simple template engine with variable substitution and error handling
 */
export class TemplateEngine {
	/**
	 * Render template with variable substitution and error handling
	 */
	render(template: PromptTemplate, variables: Record<string, unknown>): string {
		try {
			const result = this.renderSafe(template, variables)
			if (!result.success) {
				console.warn(`[TemplateEngine] Template rendering failed for ${template.id}:`, result.errors)
				if (result.fallbackUsed) {
					console.log(`[TemplateEngine] Using fallback content for ${template.id}`)
				}
			}
			return result.content
		} catch (error) {
			console.error(`[TemplateEngine] Critical error rendering template ${template.id}:`, error)
			return this.createFallbackContent(template, variables)
		}
	}

	/**
	 * Render template with detailed error information
	 */
	renderSafe(template: PromptTemplate, variables: Record<string, unknown>): TemplateRenderResult {
		const errors: string[] = []
		const warnings: string[] = []
		let fallbackUsed = false

		try {
			console.log(`[TemplateEngine] Rendering template: ${template.id}`)

			// Validate template
			if (!template || !template.content) {
				errors.push("Invalid template: missing content")
				return {
					success: false,
					content: this.createFallbackContent(template, variables),
					errors,
					warnings,
					fallbackUsed: true,
				}
			}

			// Validate required variables
			const validationErrors = this.validateTemplate(template, variables)
			if (validationErrors.length > 0) {
				warnings.push(...validationErrors)
				console.warn(`[TemplateEngine] Template validation warnings for ${template.id}:`, validationErrors)
			}

			let content = template.content

			// Merge default variables with provided variables
			const allVariables = {
				...template.defaultVariables,
				...variables,
			}

			// Process nested conditionals with error handling
			content = this.processConditionals(content, allVariables, warnings)

			// Process variable substitution with error handling
			content = this.processVariableSubstitution(content, allVariables, warnings)

			console.log(`[TemplateEngine] Successfully rendered template: ${template.id}`)

			return {
				success: true,
				content: content.trim(),
				errors,
				warnings,
				fallbackUsed,
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			errors.push(`Template rendering error: ${errorMessage}`)
			console.error(`[TemplateEngine] Error rendering template ${template.id}:`, error)

			return {
				success: false,
				content: this.createFallbackContent(template, variables),
				errors,
				warnings,
				fallbackUsed: true,
			}
		}
	}

	/**
	 * Process conditional blocks with error handling
	 */
	private processConditionals(content: string, variables: Record<string, unknown>, warnings: string[]): string {
		try {
			// Process nested conditionals from innermost to outermost
			let previousContent = ""
			let iterations = 0
			const maxIterations = 10 // Prevent infinite loops

			while (content !== previousContent && iterations < maxIterations) {
				previousContent = content
				iterations++

				// Process conditional blocks with else first (more specific pattern)
				content = content.replace(
					/\{\{#if (\w+)\}\}((?:(?!\{\{#if|\{\{\/if\}\})[\s\S])*?)\{\{else\}\}((?:(?!\{\{#if|\{\{\/if\}\})[\s\S])*?)\{\{\/if\}\}/g,
					(_, condition, ifBlock, elseBlock) => {
						try {
							const value = variables[condition]
							return value ? ifBlock : elseBlock
						} catch (error) {
							warnings.push(`Error processing conditional '${condition}': ${error}`)
							return ifBlock // Default to showing the if block
						}
					},
				)

				// Process simple conditional blocks: {{#if condition}}...{{/if}}
				content = content.replace(
					/\{\{#if (\w+)\}\}((?:(?!\{\{#if|\{\{\/if\}\})[\s\S])*?)\{\{\/if\}\}/g,
					(_, condition, block) => {
						try {
							const value = variables[condition]
							return value ? block : ""
						} catch (error) {
							warnings.push(`Error processing conditional '${condition}': ${error}`)
							return "" // Default to hiding the block
						}
					},
				)
			}

			if (iterations >= maxIterations) {
				warnings.push("Maximum conditional processing iterations reached - possible infinite loop")
			}

			return content
		} catch (error) {
			warnings.push(`Error processing conditionals: ${error}`)
			return content // Return original content if processing fails
		}
	}

	/**
	 * Process variable substitution with error handling
	 */
	private processVariableSubstitution(
		content: string,
		variables: Record<string, unknown>,
		warnings: string[],
	): string {
		try {
			// Simple variable substitution: {{variable}}
			return content.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
				try {
					const value = variables[varName]
					if (value !== undefined) {
						return String(value)
					} else {
						warnings.push(`Undefined variable: ${varName}`)
						return `[${varName}]` // Show variable name in brackets for missing variables
					}
				} catch (error) {
					warnings.push(`Error substituting variable '${varName}': ${error}`)
					return match // Return original placeholder if substitution fails
				}
			})
		} catch (error) {
			warnings.push(`Error processing variable substitution: ${error}`)
			return content // Return original content if processing fails
		}
	}

	/**
	 * Create fallback content when template rendering fails
	 */
	private createFallbackContent(template: PromptTemplate, variables: Record<string, unknown>): string {
		const phase = variables.phase || "UNKNOWN"
		const description = variables.description || "Phase guidance"

		return `🔄 CURRENT PHASE: ${phase}
📋 ${description}

⚠️  Template rendering failed. Using fallback guidance.

📊 Current Status:
   • Tests run: ${variables.testsRunCount || 0}
   • Modifications: ${variables.modificationCount || 0}
   • Tests passed: ${variables.testsPassedAfterModify || false}

Please continue with the current phase objectives.`
	}

	/**
	 * Validate template variables
	 */
	validateTemplate(template: PromptTemplate, variables: Record<string, unknown>): string[] {
		const errors: string[] = []

		if (template.requiredVariables) {
			for (const required of template.requiredVariables) {
				if (!(required in variables) && !(required in (template.defaultVariables || {}))) {
					errors.push(`Missing required variable: ${required}`)
				}
			}
		}

		return errors
	}
}

/**
 * Main prompt generator class
 */
export class SWEBenchPromptGenerator {
	private templateEngine = new TemplateEngine()
	private repositoryOverrides: Map<string, RepositoryPromptOverrides> = new Map()

	/**
	 * Register repository-specific prompt overrides
	 */
	registerRepositoryOverrides(overrides: RepositoryPromptOverrides): void {
		this.repositoryOverrides.set(overrides.repository, overrides)
	}

	/**
	 * Generate phase guidance prompt with error handling
	 */
	generatePhaseGuidance(context: PromptContext): GeneratedPrompt {
		try {
			console.log(`[PromptGenerator] Generating guidance for phase: ${context.state.phase}`)

			const { state, repositoryConfig } = context
			const phase = state.phase

			// Validate context
			if (!state || !repositoryConfig) {
				console.error("[PromptGenerator] Invalid context: missing state or repository config")
				throw new Error("Invalid context provided")
			}

			// Get template (repository override or default)
			const template = this.getPhaseTemplate(phase, repositoryConfig.repo)

			// Build variables for template
			const variables = this.buildTemplateVariables(context)

			// Render template with error handling
			const renderResult = this.templateEngine.renderSafe(template, variables)

			if (!renderResult.success) {
				console.warn(`[PromptGenerator] Template rendering had issues:`, renderResult.errors)
			}

			if (renderResult.warnings.length > 0) {
				console.warn(`[PromptGenerator] Template rendering warnings:`, renderResult.warnings)
			}

			console.log(`[PromptGenerator] Successfully generated guidance for ${phase} phase`)

			return {
				content: renderResult.content,
				templateId: template.id,
				variables,
				repository: repositoryConfig.repo,
			}
		} catch (error) {
			console.error("[PromptGenerator] Error generating phase guidance:", error)

			// Create fallback prompt
			const fallbackContent = this.createFallbackPrompt(context)

			return {
				content: fallbackContent,
				templateId: "fallback",
				variables: {},
				repository: context.repositoryConfig?.repo || "unknown",
			}
		}
	}

	/**
	 * Generate phase guidance with detailed error information
	 */
	generatePhaseGuidanceSafe(context: PromptContext): {
		success: boolean
		prompt?: GeneratedPrompt
		error?: string
		warnings: string[]
	} {
		const warnings: string[] = []

		try {
			// Validate context
			if (!context.state) {
				return {
					success: false,
					error: "Missing state in context",
					warnings,
				}
			}

			if (!context.repositoryConfig) {
				warnings.push("Missing repository config - using fallback")
			}

			const prompt = this.generatePhaseGuidance(context)

			return {
				success: true,
				prompt,
				warnings,
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			console.error("[PromptGenerator] Safe generation failed:", error)

			return {
				success: false,
				error: errorMessage,
				warnings: [...warnings, `Prompt generation failed: ${errorMessage}`],
			}
		}
	}

	/**
	 * Create fallback prompt when generation fails
	 */
	private createFallbackPrompt(context: PromptContext): string {
		const phase = context.state?.phase || "UNKNOWN"
		const testsRun = context.state?.testsRunCount || 0
		const modifications = context.state?.modificationCount || 0

		return `🔄 CURRENT PHASE: ${phase}

⚠️  Prompt generation failed. Using fallback guidance.

📊 Current Status:
   • Tests run: ${testsRun}
   • Modifications: ${modifications}
   • Phase: ${phase}

Please continue with standard ${phase} phase procedures.`
	}

	/**
	 * Get template for phase (with repository overrides)
	 */
	private getPhaseTemplate(phase: SWEBenchPhase, repository: string): PromptTemplate {
		const overrides = this.repositoryOverrides.get(repository)

		if (overrides?.phaseOverrides?.[phase]) {
			return overrides.phaseOverrides[phase]!
		}

		return DEFAULT_TEMPLATES[phase]
	}

	/**
	 * Build template variables from context
	 */
	private buildTemplateVariables(context: PromptContext): Record<string, unknown> {
		const { state, repositoryConfig, instanceId, variables = {} } = context

		// Get phase configuration
		const phaseConfig = this.getPhaseConfig(state.phase)

		// Build base variables
		const baseVariables = {
			// Phase information
			phase: state.phase,
			description: phaseConfig.description,

			// State information
			testsRunCount: state.testsRunCount,
			modificationCount: state.modificationCount,
			testsPassedAfterModify: state.testsPassedAfterModify,
			hasRunTests: state.hasRunTests,

			// File information
			modifiedFiles: state.modifiedFiles.join(", "),

			// Repository information
			repository: repositoryConfig.repo,
			projectType: repositoryConfig.projectType,
			testRunner: repositoryConfig.testRunner,

			// Instance-specific guidance
			hasInstanceGuidance: !!instanceId,
			instanceGuidance: instanceId ? generateInstanceTestDiscoveryGuidance(instanceId) : "",

			// Project exploration status (for ANALYZE phase)
			showProjectExploration: state.phase === "ANALYZE" && state.testsRunCount === 0,
			showTestDiscovery: state.phase === "ANALYZE" && !state.hasRunTests,
			readmeRead: state.readmeRead,
			testStructureExplored: state.testStructureExplored,
			targetTestsLocated: state.targetTestsLocated,
			projectExplorationComplete: state.projectExplored || (state.readmeRead && state.testStructureExplored),
			failToPassTestNames: this.getFailToPassTestNames(context).join(", "),

			// Custom variables
			...variables,
		}

		return baseVariables
	}

	/**
	 * Get FAIL_TO_PASS test names from context
	 */
	private getFailToPassTestNames(_context: PromptContext): string[] {
		// FAIL_TO_PASS test names are already injected by the SWE-bench runner
		// in the task description, so we don't need to extract them here
		return []
	}

	/**
	 * Get phase configuration (simplified version)
	 */
	private getPhaseConfig(phase: SWEBenchPhase) {
		const configs = {
			ANALYZE: {
				description: "Analyze the problem and run FAIL_TO_PASS tests first to understand expected behavior",
			},
			MODIFY: { description: "Apply code changes to fix the failing tests" },
			VERIFY: { description: "Verify the fix by re-running tests and submit the solution when ready" },
		}
		return configs[phase]
	}
}

/**
 * Create prompt generator with repository-specific configurations
 */
export function createPromptGenerator(instanceId?: string): SWEBenchPromptGenerator {
	const generator = new SWEBenchPromptGenerator()

	// Register repository-specific overrides if needed
	// This can be extended with actual repository-specific templates

	return generator
}

/**
 * Generate phase guidance using the prompt system with error handling
 */
export function generatePhaseGuidance(
	state: SWEBenchState,
	instanceId?: string,
	additionalVariables?: Record<string, unknown>,
): string {
	try {
		console.log(`[generatePhaseGuidance] Generating guidance for ${state.phase} phase, instance: ${instanceId}`)

		// Get repository configuration with error handling
		const repositoryConfig = getRepositoryConfig(instanceId || "")

		if (!repositoryConfig) {
			console.warn(`[generatePhaseGuidance] No repository config available for ${instanceId}`)
		}

		const generator = createPromptGenerator(instanceId)

		const context: PromptContext = {
			state,
			repositoryConfig,
			instanceId,
			variables: additionalVariables as Record<string, string | number | boolean> | undefined,
		}

		const result = generator.generatePhaseGuidance(context)
		console.log(`[generatePhaseGuidance] Successfully generated guidance (${result.content.length} chars)`)

		return result.content
	} catch (error) {
		console.error("[generatePhaseGuidance] Error generating phase guidance:", error)

		// Create minimal fallback guidance
		const phase = state?.phase || "UNKNOWN"
		return `🔄 CURRENT PHASE: ${phase}

⚠️  Guidance generation failed. Please continue with standard ${phase} phase procedures.

📊 Status: Tests run: ${state?.testsRunCount || 0}, Modifications: ${state?.modificationCount || 0}`
	}
}

/**
 * Generate phase guidance with detailed error information
 */
export function generatePhaseGuidanceSafe(
	state: SWEBenchState,
	instanceId?: string,
	additionalVariables?: Record<string, unknown>,
): {
	success: boolean
	content: string
	error?: string
	warnings: string[]
} {
	const warnings: string[] = []

	try {
		if (!state) {
			return {
				success: false,
				content: "⚠️  No state provided for guidance generation.",
				error: "Missing state parameter",
				warnings,
			}
		}

		const content = generatePhaseGuidance(state, instanceId, additionalVariables)

		return {
			success: true,
			content,
			warnings,
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		console.error("[generatePhaseGuidanceSafe] Safe generation failed:", error)

		const fallbackContent = `🔄 CURRENT PHASE: ${state?.phase || "UNKNOWN"}

⚠️  Guidance generation failed: ${errorMessage}

Please continue with standard phase procedures.`

		return {
			success: false,
			content: fallbackContent,
			error: errorMessage,
			warnings: [...warnings, `Guidance generation failed: ${errorMessage}`],
		}
	}
}
