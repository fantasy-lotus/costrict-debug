/**
 * SWE-bench Module
 *
 * Provides state machine enforcement for SWE-bench tasks to ensure
 * the agent follows the correct workflow: run tests first, then modify code.
 */

export {
	SWEBenchStateMachine,
	createInitialState,
	isTestCommand,
	isCodeModificationTool,
	PHASE_CONFIGS,
	type SWEBenchPhase,
	type SWEBenchState,
	type PhaseConfig,
} from "./state-machine"

export {
	SWEBenchToolInterceptor,
	getActiveSWEBenchInterceptor,
	activateSWEBenchMode,
	deactivateSWEBenchMode,
	isSWEBenchModeActive,
	validateSWEBenchToolUse,
	recordSWEBenchToolExecution,
	applySWEBenchPathMapping,
	getSWEBenchReasoningConfig,
	type SWEBenchInterceptorConfig,
} from "./tool-interceptor"

export {
	showSWEBenchSubmitReview,
	shouldEnforceSWEBenchReview,
	hasConfirmedSWEBenchReview,
	SWEBENCH_REVIEW_CHECKLIST,
	shouldShowFirstModificationGuidance,
	getFirstModificationGuidance,
	SWEBENCH_FIRST_MODIFICATION_GUIDANCE,
} from "./submit-review"

export {
	getInstanceTestGuidance,
	generateInstanceTestDiscoveryGuidance,
	getRecommendedTestCommand,
	extractLikelyTestNames,
	type RepoTestGuidance,
} from "./instance-prompts"

export {
	getRepositoryConfig,
	getRepositoryConfigSafe,
	checkUnderstandingRequirement,
	type RepositoryConfig,
	type ConfigurationResult,
} from "./repository-config"

export {
	SWEBenchPromptGenerator,
	TemplateEngine,
	createPromptGenerator,
	generatePhaseGuidance,
	generatePhaseGuidanceSafe,
	type PromptContext,
	type PromptTemplate,
	type GeneratedPrompt,
	type RepositoryPromptOverrides,
} from "./prompt-generator"

export {
	createFlexibleExplorationStrategy,
	createProgressiveGuidanceEscalator,
	DefaultFlexibleExplorationStrategy,
	RepositoryAwareExplorationStrategy,
	ExplorationStrategyFactory,
	ProgressiveGuidanceEscalator,
	type FlexibleExplorationStrategy,
	type ExplorationRecommendation,
	type ModificationReadiness,
	type UnderstandingAssessment,
	type UnderstandingFactor,
	type ExplorationState,
	type ToolExecutionRecord,
	type ExplorationPriority,
	type UnderstandingLevel,
	type GuidanceIntensity,
} from "./flexible-exploration"

export {
	InstancePromptTestAnalyzer,
	type TestCommandAnalysis,
	type TestClassification,
	type PatternMatch,
	type TestEffectiveness,
	type TestType,
	type TestCategory,
} from "./test-analyzer"

export {
	SWEBenchErrorHandler,
	SWEBenchLogger,
	RepositoryConfigError,
	TemplateRenderError,
	StateTransitionError,
	TestAnalysisError,
	errorHandler,
	logger,
	createErrorContext,
	withErrorHandling,
	createSafeWrapper,
	type ErrorContext,
	type FallbackResult,
	type LogLevel,
} from "./error-handling"

// SWE-bench 专属上下文压缩
export {
	summarizeSWEBenchConversation,
	shouldTriggerSWEBenchCondense,
	manageSWEBenchContext,
	SWEBENCH_CONDENSE_THRESHOLD,
	SWEBENCH_TOOL_RESULTS_TO_KEEP,
	SWEBENCH_MAX_TOOL_RESULT_LENGTH,
	type SWEBenchSummarizeResponse,
	type SWEBenchContextManagementOptions,
	type SWEBenchContextManagementResult,
} from "./context-compression"
