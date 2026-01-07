/**
 * SWE-bench Repository-Specific Prompt System
 *
 * Provides tailored testing guidance for different SWE-bench repositories
 * based on their official test framework configurations.
 *
 * Updated to work with the new unified architecture including repository
 * configuration system and modular prompt generation.
 */

import type { ToolName } from "@roo-code/types"
import type { RepositoryConfig } from "./repository-config"
import type { SWEBenchPhase } from "./state-machine"

export interface PhaseOverride {
	/** Tools allowed in this phase (overrides default) */
	readonly allowedTools?: ToolName[]
	/** Tools blocked in this phase (in addition to default blocks) */
	readonly blockedTools?: ToolName[]
	/** Custom validation rules for this phase */
	readonly customValidation?: ValidationRule[]
	/** Prompt overrides for this phase */
	readonly promptOverrides?: Record<string, string>
}

export interface ValidationRule {
	/** Rule identifier */
	readonly id: string
	/** Condition that must be met */
	readonly condition: (params: Record<string, unknown>) => boolean
	/** Error message if condition fails */
	readonly errorMessage: string
}

/**
 * Legacy interface for backward compatibility
 * @deprecated Use RepositoryConfig from repository-config.ts instead
 */
export interface LegacyRepoTestGuidance {
	/** Repository identifier (e.g., 'django/django') */
	repo: string
	/** Project type identifier */
	projectType: "django" | "pytest" | "tox" | "custom"
	/** Official test runner command from SWE-bench */
	testRunner: string
	/** Test discovery strategy */
	testDiscovery: string
	/** Common test patterns for this repository */
	testPatterns: string[]
	/** Specific guidance for FAIL_TO_PASS tests */
	failToPassGuidance: string
	/** Example commands */
	examples: string[]
	/** Repository-specific phase overrides */
	phaseOverrides?: Partial<Record<SWEBenchPhase, PhaseOverride>>
}

export interface RepoTestGuidance extends LegacyRepoTestGuidance {
	// Inherits all fields from LegacyRepoTestGuidance for backward compatibility
	__repoTestGuidanceBrand?: never
}

/**
 * SWE-bench verified repositories (12 total)
 * Based on official SWE-bench verified dataset
 */
export const SWE_BENCH_VERIFIED_REPOS = [
	"astropy/astropy",
	"django/django",
	"flask/flask",
	"matplotlib/matplotlib",
	"psf/requests",
	"pylint-dev/pylint",
	"pytest-dev/pytest",
	"scikit-learn/scikit-learn",
	"mwaskom/seaborn",
	"sphinx-doc/sphinx",
	"sympy/sympy",
	"pydata/xarray",
] as const

export type SWEBenchRepo = (typeof SWE_BENCH_VERIFIED_REPOS)[number]

/**
 * Check if a repository is in the SWE-bench verified dataset
 */
export function isSWEBenchVerifiedRepo(repo: string): repo is SWEBenchRepo {
	return SWE_BENCH_VERIFIED_REPOS.includes(repo as SWEBenchRepo)
}

/**
 * Get all SWE-bench verified repositories
 */
export function getSWEBenchVerifiedRepos(): readonly string[] {
	return SWE_BENCH_VERIFIED_REPOS
}

/**
 * Validate that an instance belongs to a verified SWE-bench repository
 */
export function validateSWEBenchInstance(instanceId: string): {
	isValid: boolean
	repo: string
	isVerified: boolean
} {
	const repo = extractRepoFromInstanceId(instanceId)
	const isVerified = isSWEBenchVerifiedRepo(repo)

	return {
		isValid: repo !== instanceId, // If extraction failed, repo equals instanceId
		repo,
		isVerified,
	}
}

/**
 * Get repository statistics for SWE-bench verified dataset
 */
export function getSWEBenchStats(): {
	totalRepos: number
	verifiedRepos: readonly string[]
	supportedProjectTypes: string[]
} {
	const guidance = getRepoTestGuidanceList()
	const projectTypes = [...new Set(guidance.filter((g) => g.repo !== "*").map((g) => g.projectType))]

	return {
		totalRepos: SWE_BENCH_VERIFIED_REPOS.length,
		verifiedRepos: SWE_BENCH_VERIFIED_REPOS,
		supportedProjectTypes: projectTypes,
	}
}

/**
 * Find repositories by project type
 */
export function getReposByProjectType(projectType: RepoTestGuidance["projectType"]): string[] {
	const guidance = getRepoTestGuidanceList()
	return guidance.filter((g) => g.projectType === projectType && g.repo !== "*").map((g) => g.repo)
}

/**
 * Repository configuration mapping for SWE-bench verified repositories
 */
const REPO_CONFIGS: Record<string, Omit<RepoTestGuidance, "repo">> = {
	"django/django": {
		projectType: "django",
		testRunner: "./tests/runtests.py",
		testDiscovery: `Django's own test suite uses ./tests/runtests.py (not manage.py test):
   1. Test labels are Django app names or test module paths
   2. Format: ./tests/runtests.py [app_name] [--verbosity 2] [--settings=test_sqlite]
   3. Use --verbosity 2 for detailed output, --settings=test_sqlite for SQLite backend
   4. Labels can be app names (admin, auth) or specific test modules`,
		testPatterns: ["admin", "auth", "contenttypes", "generic_relations", "i18n", "model_fields", "migrations"],
		failToPassGuidance: `Django's test suite execution patterns:
   • Single app: ./tests/runtests.py admin --verbosity 2 --settings=test_sqlite
   • Multiple apps: ./tests/runtests.py admin auth --verbosity 2 --settings=test_sqlite
   • All tests: ./tests/runtests.py --verbosity 2 --settings=test_sqlite
   • Specific test: ./tests/runtests.py admin.AdminTest.test_method --verbosity 2
   • With parallel: ./tests/runtests.py --parallel 1 --verbosity 2 --settings=test_sqlite
   • Fast fail: ./tests/runtests.py --failfast --verbosity 2 --settings=test_sqlite`,
		examples: [
			"./tests/runtests.py admin --verbosity 2 --settings=test_sqlite",
			"./tests/runtests.py admin auth --verbosity 2 --settings=test_sqlite",
			"./tests/runtests.py --verbosity 2 --settings=test_sqlite",
			"./tests/runtests.py admin.AdminTest.test_method --verbosity 2",
			"./tests/runtests.py --parallel 1 --verbosity 2 --settings=test_sqlite",
			"./tests/runtests.py --failfast --verbosity 2 --settings=test_sqlite",
		],
	},
	"astropy/astropy": {
		projectType: "pytest",
		testRunner: "pytest -rA --tb=long",
		testDiscovery: `Astropy uses pytest for testing with tests in astropy/*/tests/ directories:
   1. Tests follow pytest discovery: test_*.py or *_test.py files
   2. Classes prefixed with Test (no __init__), functions/methods with test_
   3. Use -P option for subpackage selection: pytest -P wcs,utils
   4. Use -n for parallel execution: pytest -n auto`,
		testPatterns: ["astropy/*/tests/", "test_*.py", "*_test.py", "astropy/tests/"],
		failToPassGuidance: `Astropy test execution patterns:
   • All tests: pytest -rA --tb=long astropy
   • Subpackage batch: pytest -rA --tb=long -P wcs,utils
   • Directory: pytest -rA --tb=long astropy/modeling
   • Single file: pytest -rA --tb=long astropy/wcs/tests/test_wcs.py
   • By keyword: pytest -rA --tb=long astropy/units -k float_dtype_promotion
   • Node ID: pytest -rA --tb=long astropy/units/tests/test_quantity.py::TestQuantityCreation::test_float_dtype_promotion
   • Parallel: pytest -rA --tb=long -n 4 or pytest -rA --tb=long -n auto`,
		examples: [
			"pytest -rA --tb=long astropy",
			"pytest -rA --tb=long -P wcs,utils",
			"pytest -rA --tb=long astropy/modeling",
			"pytest -rA --tb=long astropy/wcs/tests/test_wcs.py",
			"pytest -rA --tb=long astropy/units -k float_dtype_promotion",
			"pytest -rA --tb=long astropy/units/tests/test_quantity.py::TestQuantityCreation::test_float_dtype_promotion",
			"pytest -rA --tb=long -n auto",
		],
	},
	"scikit-learn/scikit-learn": {
		projectType: "pytest",
		testRunner: "python -m pytest --showlocals --durations=20",
		testDiscovery: `Scikit-learn uses pytest with tests co-located in sklearn/<module>/tests/:
   1. Module tests: sklearn/<module>/tests/test_<algorithm>.py
   2. Common API tests: sklearn/tests/test_common.py (parametrize_with_checks)
   3. Array API tests: pytest -k "array_api" -v
   4. Tests organized by algorithm modules with specific test files`,
		testPatterns: [
			"sklearn/*/tests/",
			"test_*.py",
			"sklearn/tests/test_common.py",
			"sklearn/utils/estimator_checks.py",
		],
		failToPassGuidance: `Scikit-learn test execution patterns:
   • All tests: python -m pytest --showlocals --durations=20 --pyargs sklearn
   • Module tests: python -m pytest --showlocals --durations=20 sklearn/linear_model
   • Single file: python -m pytest --showlocals --durations=20 sklearn/linear_model/tests/test_logistic.py
   • Single test: python -m pytest --showlocals --durations=20 -v sklearn/linear_model/tests/test_logistic.py::test_sparsify
   • By keyword: python -m pytest --showlocals --durations=20 sklearn/tests/test_common.py -v -k LogisticRegression
   • Array API: python -m pytest --showlocals --durations=20 -k "array_api" -v
   • Common tests for estimator: python -m pytest --showlocals --durations=20 sklearn/tests/test_common.py -v -k EstimatorName`,
		examples: [
			"python -m pytest --showlocals --durations=20 --pyargs sklearn",
			"python -m pytest --showlocals --durations=20 sklearn/linear_model",
			"python -m pytest --showlocals --durations=20 sklearn/linear_model/tests/test_logistic.py",
			"python -m pytest --showlocals --durations=20 -v sklearn/linear_model/tests/test_logistic.py::test_sparsify",
			"python -m pytest --showlocals --durations=20 sklearn/tests/test_common.py -v -k LogisticRegression",
			'python -m pytest --showlocals --durations=20 -k "array_api" -v',
			"python -m pytest --showlocals --durations=20 --lf -x",
		],
	},
	"matplotlib/matplotlib": {
		projectType: "pytest",
		testRunner: "pytest -rfEsXR --maxfail=50 --timeout=300 --durations=25",
		testDiscovery: `Matplotlib uses pytest with tests in lib/matplotlib/tests/:
   1. Tests follow pytest discovery: test_*.py files, test* functions/Test* classes
   2. Many tests use image comparison (@image_comparison, @check_figures_equal)
   3. Tests correspond to modules: test_mathtext.py tests mathtext.py
   4. Automatic cleanup via matplotlib.testing.conftest.mpl_test_settings fixture`,
		testPatterns: ["lib/matplotlib/tests/", "test_*.py", "test_*", "Test*"],
		failToPassGuidance: `Matplotlib test execution patterns:
   • All tests: pytest -rfEsXR --maxfail=50 --timeout=300 --durations=25 (from root directory)
   • Installed version: pytest -rfEsXR --maxfail=50 --timeout=300 --durations=25 --pyargs matplotlib.tests
   • Single test: pytest -rfEsXR --maxfail=50 --timeout=300 --durations=25 lib/matplotlib/tests/test_simplification.py::test_clipping
   • Installed single: pytest -rfEsXR --maxfail=50 --timeout=300 --durations=25 --pyargs matplotlib.tests.test_simplification.py::test_clipping
   • Parallel: pytest -rfEsXR --maxfail=50 --timeout=300 --durations=25 -n auto (requires pytest-xdist)
   • Image comparison tests generate result_images/ directory`,
		examples: [
			"pytest -rfEsXR --maxfail=50 --timeout=300 --durations=25",
			"pytest -rfEsXR --maxfail=50 --timeout=300 --durations=25 --pyargs matplotlib.tests",
			"pytest -rfEsXR --maxfail=50 --timeout=300 --durations=25 lib/matplotlib/tests/test_simplification.py::test_clipping",
			"pytest -rfEsXR --maxfail=50 --timeout=300 --durations=25 --pyargs matplotlib.tests.test_simplification.py::test_clipping",
			"pytest -rfEsXR --maxfail=50 --timeout=300 --durations=25 -n auto",
			"pytest -rfEsXR --maxfail=50 --timeout=300 --durations=25 lib/matplotlib/tests/test_mathtext.py",
		],
	},
	"sympy/sympy": {
		projectType: "custom",
		testRunner: "python bin/test -C --verbose",
		testDiscovery: `SymPy uses bin/test script (pytest wrapper) with tests in sympy/*/tests/:
   1. Test files follow pattern: test_<thing>.py in tests/ directories
   2. Test functions start with test_ and use assert statements
   3. bin/test acts as interface to pytest with SymPy-specific options
   4. Tests are co-located with code: sympy/<submodule>/tests/test_<file>.py`,
		testPatterns: ["sympy/*/tests/", "test_*.py", "sympy/<submodule>/tests/test_<file>.py"],
		failToPassGuidance: `SymPy test execution patterns:
   • All tests: python bin/test -C --verbose
   • Single file: python bin/test -C --verbose test_basic (without .py)
   • Full path: python bin/test -C --verbose sympy/core/tests/test_basic.py
   • Specific function: python bin/test -C --verbose sympy/core/tests/test_basic.py -k test_equality
   • Multiple modules: python bin/test -C --verbose /core /utilities
   • With pytest syntax: pytest -v sympy/printing/pretty/tests/test_pretty.py::test_upretty_sub_super
   • Quality tests: python bin/test -C --verbose code_quality`,
		examples: [
			"python bin/test -C --verbose",
			"python bin/test -C --verbose test_basic",
			"python bin/test -C --verbose sympy/core/tests/test_basic.py",
			"python bin/test -C --verbose sympy/core/tests/test_basic.py -k test_equality",
			"python bin/test -C --verbose /core /utilities",
			"pytest -v sympy/printing/pretty/tests/test_pretty.py::test_upretty_sub_super",
			"python bin/test -C --verbose code_quality",
		],
	},
	"sphinx-doc/sphinx": {
		projectType: "pytest",
		testRunner: "python -X dev -X warn_default_encoding -m pytest -v --durations 25",
		testDiscovery: `Sphinx uses pytest for testing with tests in tests/ directory:
   1. Tests follow pytest discovery: test_*.py files, test_* functions
   2. Use Python development mode (-X dev) and encoding warnings (-X warn_default_encoding)
   3. Tests can be marked with @pytest.mark.sphinx for SphinxTestApp fixture
   4. Can also use tox for isolated environments: tox -e py311`,
		testPatterns: ["tests/", "test_*.py", "tests/test_builders/", "tests/test_extensions/"],
		failToPassGuidance: `Sphinx test execution patterns:
   • All tests: python -X dev -X warn_default_encoding -m pytest -v --durations 25
   • Single file: python -X dev -X warn_default_encoding -m pytest -v tests/test_build.py
   • Specific test: python -X dev -X warn_default_encoding -m pytest -v tests/test_build.py::test_specific
   • By keyword: python -X dev -X warn_default_encoding -m pytest -v -k "test_build"
   • With tox: tox -e py311 -- tests/test_build.py
   • Parallel: python -m pytest -n logical --dist=worksteal -vv --durations 25`,
		examples: [
			"python -X dev -X warn_default_encoding -m pytest -v --durations 25",
			"python -X dev -X warn_default_encoding -m pytest -v tests/test_build.py",
			"python -X dev -X warn_default_encoding -m pytest -v tests/test_build.py::test_specific",
			'python -X dev -X warn_default_encoding -m pytest -v -k "test_build"',
			"tox -e py311 -- tests/test_build.py",
			"python -m pytest -n logical --dist=worksteal -vv --durations 25",
		],
	},
	"flask/flask": {
		projectType: "pytest",
		testRunner: "python -m pytest -xvs",
		testDiscovery: `Flask uses pytest with tests in tests/ directory:
   1. Tests follow pytest discovery: test_*.py files, test_* functions
   2. Use -x to stop on first failure, -v for verbose, -s to show output
   3. Tests are organized by functionality in tests/ directory
   4. Application context and fixtures defined in conftest.py`,
		testPatterns: ["tests/", "test_*.py", "tests/test_*.py"],
		failToPassGuidance: `Flask test execution patterns:
   • All tests: python -m pytest -xvs
   • Single file: python -m pytest -xvs tests/test_basic.py
   • Specific test: python -m pytest -xvs tests/test_basic.py::test_specific
   • By keyword: python -m pytest -xvs -k "test_request"
   • With coverage: python -m pytest -xvs --cov=flask
   • Parallel: python -m pytest -xvs -n auto`,
		examples: [
			"python -m pytest -xvs",
			"python -m pytest -xvs tests/test_basic.py",
			"python -m pytest -xvs tests/test_basic.py::test_specific",
			'python -m pytest -xvs -k "test_request"',
			"python -m pytest -xvs --cov=flask",
			"python -m pytest -xvs -n auto",
		],
	},
	"psf/requests": {
		projectType: "pytest",
		testRunner: "python -m pytest -v",
		testDiscovery: `Requests uses pytest with tests primarily in tests/test_requests.py:
   1. Main test file: tests/test_requests.py with TestRequests class
   2. Tests follow pytest discovery: test_*.py files, test_* functions
   3. Uses pytest.mark.parametrize for parameterized tests
   4. Fixtures defined in conftest.py (httpbin, httpbin_secure)`,
		testPatterns: ["tests/", "test_*.py", "tests/test_requests.py", "TestRequests"],
		failToPassGuidance: `Requests test execution patterns:
   • All tests: python -m pytest -v tests/
   • Main test file: python -m pytest -v tests/test_requests.py
   • Specific test: python -m pytest -v tests/test_requests.py::TestRequests::test_specific
   • By keyword: python -m pytest -v -k "test_http"
   • With coverage: python -m pytest -v --cov=requests
   • Parallel: python -m pytest -v -n auto`,
		examples: [
			"python -m pytest -v tests/",
			"python -m pytest -v tests/test_requests.py",
			"python -m pytest -v tests/test_requests.py::TestRequests::test_specific",
			'python -m pytest -v -k "test_http"',
			"python -m pytest -v --cov=requests",
			"python -m pytest -v -n auto",
		],
	},
	"mwaskom/seaborn": {
		projectType: "pytest",
		testRunner: "make test",
		testDiscovery: `Seaborn uses pytest via make test command:
   1. Primary command: make test (runs pytest internally)
   2. Tests are in tests/ directory with subdirectories like tests/_core/
   3. Test files follow pytest discovery: test_*.py files, test_* functions
   4. Tests include plotting, statistical, and utility functions`,
		testPatterns: ["tests/", "test_*.py", "tests/_core/", "tests/test_*.py"],
		failToPassGuidance: `Seaborn test execution patterns:
   • All tests: make test
   • Direct pytest: python -m pytest -v tests/
   • Single file: python -m pytest -v tests/test_distributions.py
   • Specific test: python -m pytest -v tests/test_distributions.py::test_specific
   • Core tests: python -m pytest -v tests/_core/
   • By keyword: python -m pytest -v -k "test_plot"`,
		examples: [
			"make test",
			"python -m pytest -v tests/",
			"python -m pytest -v tests/test_distributions.py",
			"python -m pytest -v tests/test_distributions.py::test_specific",
			"python -m pytest -v tests/_core/",
			'python -m pytest -v -k "test_plot"',
		],
	},
	"pydata/xarray": {
		projectType: "pytest",
		testRunner: "python -m pytest -xvs",
		testDiscovery: `Xarray uses pytest with tests in xarray/tests/ directory:
   1. Tests follow pytest discovery: test_*.py files, test_* functions
   2. Use -x to stop on first failure, -v for verbose, -s to show output
   3. Tests organized by functionality: test_dataset.py, test_dataarray.py, etc.
   4. Array and dataset manipulation, indexing, and computation tests`,
		testPatterns: ["xarray/tests/", "test_*.py", "xarray/tests/test_*.py"],
		failToPassGuidance: `Xarray test execution patterns:
   • All tests: python -m pytest -xvs xarray/tests/
   • Single file: python -m pytest -xvs xarray/tests/test_dataset.py
   • Specific test: python -m pytest -xvs xarray/tests/test_dataset.py::test_specific
   • By keyword: python -m pytest -xvs -k "test_dataset"
   • With coverage: python -m pytest -xvs --cov=xarray
   • Parallel: python -m pytest -xvs -n auto`,
		examples: [
			"python -m pytest -xvs xarray/tests/",
			"python -m pytest -xvs xarray/tests/test_dataset.py",
			"python -m pytest -xvs xarray/tests/test_dataset.py::test_specific",
			'python -m pytest -xvs -k "test_dataset"',
			"python -m pytest -xvs --cov=xarray",
			"python -m pytest -xvs -n auto",
		],
	},
	"pylint-dev/pylint": {
		projectType: "pytest",
		testRunner: "python -m pytest -xvs",
		testDiscovery: `Pylint uses pytest with tests in tests/ directory:
   1. Tests follow pytest discovery: test_*.py files, test_* functions
   2. Use -x to stop on first failure, -v for verbose, -s to show output
   3. Tests organized by functionality: checkers, functional tests, unit tests
   4. Linting rules, checker behavior, and code analysis tests`,
		testPatterns: ["tests/", "test_*.py", "tests/checkers/", "tests/functional/"],
		failToPassGuidance: `Pylint test execution patterns:
   • All tests: python -m pytest -xvs tests/
   • Checker tests: python -m pytest -xvs tests/checkers/
   • Functional tests: python -m pytest -xvs tests/functional/
   • Single file: python -m pytest -xvs tests/test_checkers.py
   • Specific test: python -m pytest -xvs tests/test_checkers.py::test_specific
   • By keyword: python -m pytest -xvs -k "test_checker"`,
		examples: [
			"python -m pytest -xvs tests/",
			"python -m pytest -xvs tests/checkers/",
			"python -m pytest -xvs tests/functional/",
			"python -m pytest -xvs tests/test_checkers.py",
			"python -m pytest -xvs tests/test_checkers.py::test_specific",
			'python -m pytest -xvs -k "test_checker"',
		],
	},
	"pytest-dev/pytest": {
		projectType: "pytest",
		testRunner: "pytest",
		testDiscovery: `Pytest uses itself for testing with comprehensive discovery patterns:
   1. Files: test_*.py or *_test.py (configurable via python_files)
   2. Classes: Test* prefix (configurable via python_classes)
   3. Functions: test_* prefix (configurable via python_functions)
   4. Node IDs: path/to/test_file.py::TestClass::test_method[param]`,
		testPatterns: ["test_*.py", "*_test.py", "Test*", "test_*"],
		failToPassGuidance: `Pytest test execution patterns:
   • All tests: pytest
   • Single file: pytest tests/test_mod.py
   • Single function: pytest tests/test_mod.py::test_func
   • Class tests: pytest tests/test_mod.py::TestClass
   • Specific method: pytest tests/test_mod.py::TestClass::test_method
   • Parametrized: pytest tests/test_mod.py::test_func[x1,y2]
   • By keyword: pytest -k 'MyClass and not method'
   • By marker: pytest -m slow
   • Directory: pytest testing/
   • Package: pytest --pyargs pkg.testing`,
		examples: [
			"pytest",
			"pytest tests/test_mod.py::test_func",
			"pytest tests/test_mod.py::TestClass::test_method",
			'pytest -k "MyClass and not method"',
			"pytest -m slow",
			"pytest testing/",
			"pytest --pyargs pkg.testing",
		],
	},
}

/**
 * Generic fallback configuration for unknown repositories
 */
const GENERIC_CONFIG: Omit<RepoTestGuidance, "repo"> = {
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
}

/**
 * Convert legacy RepoTestGuidance to new RepositoryConfig format
 */
export function convertToRepositoryConfig(guidance: RepoTestGuidance, instanceId: string): RepositoryConfig {
	return {
		...guidance,
		// Default values for new architecture
		minReadCalls: 5,
		minTestCalls: 2,
		strictExploration: false,
	}
}

/**
 * Create repository configuration from instance ID using legacy guidance
 */
export function createRepositoryConfigFromInstance(instanceId: string): RepositoryConfig {
	const guidance = getRepoTestGuidance(instanceId)
	return convertToRepositoryConfig(guidance, instanceId)
}

/**
 * Repository-specific test guidance mapping
 * Dynamically generates guidance based on SWE-bench verified repositories
 */
function createRepoTestGuidance(): RepoTestGuidance[] {
	const guidance: RepoTestGuidance[] = []

	// Add guidance for all verified SWE-bench repositories
	for (const repo of SWE_BENCH_VERIFIED_REPOS) {
		const config = REPO_CONFIGS[repo]
		if (config) {
			guidance.push({
				repo,
				...config,
			})
		}
	}

	// Add generic fallback
	guidance.push({
		repo: "*",
		...GENERIC_CONFIG,
	})

	return guidance
}

/**
 * Repository-specific test guidance mapping
 * Lazily initialized to avoid circular dependencies
 */
let _repoTestGuidance: RepoTestGuidance[] | null = null

export function getRepoTestGuidanceList(): RepoTestGuidance[] {
	if (!_repoTestGuidance) {
		_repoTestGuidance = createRepoTestGuidance()
	}
	return _repoTestGuidance
}

/**
 * Extract repository name from instance ID (e.g., 'django__django-12325' -> 'django/django')
 */
function extractRepoFromInstanceId(instanceId: string): string {
	// Convert instance ID format to repo format
	// django__django-12325 -> django/django
	// astropy__astropy-1234 -> astropy/astropy
	// scikit-learn__scikit-learn-5678 -> scikit-learn/scikit-learn

	// Split by double underscore first
	const parts = instanceId.split("__")
	if (parts.length >= 2) {
		const org = parts[0]
		// For the repo part, we need to handle cases where the repo name contains hyphens
		// Split by the last hyphen (which should be before the issue number)
		const repoPart = parts[1]
		const lastHyphenIndex = repoPart.lastIndexOf("-")

		if (lastHyphenIndex > 0) {
			const repo = repoPart.substring(0, lastHyphenIndex)
			return `${org}/${repo}`
		} else {
			// No hyphen found, use the whole second part
			return `${org}/${repoPart}`
		}
	}

	// Fallback: return as-is if format doesn't match
	return instanceId
}

/**
 * Get repository-specific test guidance based on instance ID
 */
export function getRepoTestGuidance(instanceId: string): RepoTestGuidance {
	const repo = extractRepoFromInstanceId(instanceId)
	const allGuidance = getRepoTestGuidanceList()

	// Find matching repository guidance
	for (const item of allGuidance) {
		if (item.repo === repo) {
			return item
		}
	}

	// Fallback to generic guidance (last item in array)
	return allGuidance[allGuidance.length - 1]
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use getRepoTestGuidance instead
 */
export function getInstanceTestGuidance(instanceId: string): RepoTestGuidance {
	return getRepoTestGuidance(instanceId)
}

/**
 * Get repository configuration using the new architecture
 * This is the preferred method for new code
 */
export function getRepositoryConfigFromInstance(instanceId: string): RepositoryConfig {
	return createRepositoryConfigFromInstance(instanceId)
}

/**
 * Check if an instance has repository-specific configuration
 */
export function hasRepositorySpecificConfig(instanceId: string): boolean {
	const repo = extractRepoFromInstanceId(instanceId)
	return isSWEBenchVerifiedRepo(repo)
}

/**
 * Get repository-specific phase overrides for a given instance and phase
 */
export function getPhaseOverrides(instanceId: string, phase: SWEBenchPhase): PhaseOverride | undefined {
	const guidance = getRepoTestGuidance(instanceId)
	return guidance.phaseOverrides?.[phase]
}

/**
 * Migrate legacy guidance data to new repository configuration format
 * This function helps with the transition to the new architecture
 */
export function migrateGuidanceToConfig(guidance: RepoTestGuidance[]): RepositoryConfig[] {
	return guidance
		.filter((g) => g.repo !== "*") // Exclude generic fallback
		.map((g) => convertToRepositoryConfig(g, g.repo))
}

/**
 * Generate repository-specific test discovery guidance for ANALYZE phase
 * Updated to work with the new architecture while maintaining backward compatibility
 */
export function generateInstanceTestDiscoveryGuidance(instanceId: string): string {
	const guidance = getRepoTestGuidance(instanceId)
	const repo = extractRepoFromInstanceId(instanceId)
	const config = createRepositoryConfigFromInstance(instanceId)

	return `📋 REPOSITORY-SPECIFIC TEST DISCOVERY (${instanceId}):

🎯 REPOSITORY: ${repo}
🎯 PROJECT TYPE: ${guidance.projectType.toUpperCase()}

${guidance.testDiscovery}

🔍 TEST PATTERNS TO LOOK FOR:
${guidance.testPatterns.map((pattern: string) => `   • ${pattern}`).join("\n")}

${guidance.failToPassGuidance}

💡 EXAMPLE COMMANDS:
${guidance.examples.map((cmd: string) => `   • ${cmd}`).join("\n")}

📊 UNDERSTANDING REQUIREMENTS:
   • Minimum read calls: ${config.minReadCalls}
   • Minimum test calls: ${config.minTestCalls}

⚠️  IMPORTANT: Use the project's native test runner. Do NOT install pytest or other dependencies.`
}

/**
 * Generate repository-specific guidance for any phase
 * This is the new unified guidance generation function
 */
export function generateRepositoryGuidance(instanceId: string, phase: SWEBenchPhase, context?: any): string {
	const guidance = getRepoTestGuidance(instanceId)
	const repo = extractRepoFromInstanceId(instanceId)
	const phaseOverrides = getPhaseOverrides(instanceId, phase)

	let phaseGuidance = ""

	switch (phase) {
		case "ANALYZE":
			phaseGuidance = generateInstanceTestDiscoveryGuidance(instanceId)
			break
		case "MODIFY":
			phaseGuidance = `🔧 MODIFICATION GUIDANCE (${repo}):

Use the project's established patterns and conventions.
${guidance.failToPassGuidance}

💡 RECOMMENDED TEST COMMANDS:
${guidance.examples
	.slice(0, 3)
	.map((cmd: string) => `   • ${cmd}`)
	.join("\n")}`
			break
		case "VERIFY":
			phaseGuidance = `✅ VERIFICATION GUIDANCE (${repo}):

Run the same test commands used in ANALYZE phase to verify your changes.

💡 VERIFICATION COMMANDS:
${guidance.examples
	.slice(0, 3)
	.map((cmd: string) => `   • ${cmd}`)
	.join("\n")}`
			break
		// COMPLETE phase removed - completion happens in VERIFY phase
	}

	// Add phase-specific overrides if available
	if (phaseOverrides?.promptOverrides) {
		const overrideText = Object.entries(phaseOverrides.promptOverrides)
			.map(([key, value]) => `${key}: ${value}`)
			.join("\n")
		phaseGuidance += `\n\n📝 PHASE-SPECIFIC NOTES:\n${overrideText}`
	}

	return phaseGuidance
}

/**
 * Get recommended test command for an instance
 */
export function getRecommendedTestCommand(instanceId: string, testName?: string): string | null {
	if (!instanceId) return null

	const guidance = getRepoTestGuidance(instanceId)

	if (testName && guidance.examples.length > 0) {
		// Try to find an example that includes the test name
		const specificExample = guidance.examples.find((ex: string) =>
			ex.toLowerCase().includes(testName.toLowerCase()),
		)
		if (specificExample) {
			return specificExample
		}
	}

	// Return the most specific example or the test runner
	return guidance.examples[0] || guidance.testRunner
}

/**
 * Extract likely test names from instance ID or problem description
 */
export function extractLikelyTestNames(instanceId: string, problemText?: string): string[] {
	const testNames: string[] = []

	// Extract from instance ID patterns
	const repo = extractRepoFromInstanceId(instanceId)
	if (repo === "django/django") {
		// Common Django test patterns
		if (problemText) {
			const matches = problemText.match(/test_\w+/g)
			if (matches) {
				testNames.push(...matches)
			}
		}
	}

	return testNames
}

/**
 * Integration functions for the new unified architecture
 */

/**
 * Get repository-specific tool restrictions for a given phase
 */
export function getRepositoryToolRestrictions(
	instanceId: string,
	phase: SWEBenchPhase,
): {
	allowedTools?: ToolName[]
	blockedTools?: ToolName[]
} {
	const phaseOverrides = getPhaseOverrides(instanceId, phase)
	return {
		allowedTools: phaseOverrides?.allowedTools,
		blockedTools: phaseOverrides?.blockedTools,
	}
}

/**
 * Validate tool usage against repository-specific rules
 */
export function validateRepositoryToolUsage(
	instanceId: string,
	phase: SWEBenchPhase,
	toolName: ToolName,
	params: Record<string, unknown>,
): {
	allowed: boolean
	reason?: string
	suggestion?: string
} {
	const phaseOverrides = getPhaseOverrides(instanceId, phase)

	if (!phaseOverrides?.customValidation) {
		return { allowed: true }
	}

	for (const rule of phaseOverrides.customValidation) {
		if (!rule.condition(params)) {
			return {
				allowed: false,
				reason: rule.errorMessage,
				suggestion: `Check repository-specific requirements for ${toolName}`,
			}
		}
	}

	return { allowed: true }
}

/**
 * Get repository-specific prompt template overrides
 */
export function getRepositoryPromptOverrides(instanceId: string, phase: SWEBenchPhase): Record<string, string> {
	const phaseOverrides = getPhaseOverrides(instanceId, phase)
	return phaseOverrides?.promptOverrides || {}
}

/**
 * Check if repository has specific configuration for a phase
 */
export function hasPhaseSpecificConfig(instanceId: string, phase: SWEBenchPhase): boolean {
	const phaseOverrides = getPhaseOverrides(instanceId, phase)
	return phaseOverrides !== undefined
}

/**
 * Get all repository configurations for migration purposes
 */
export function getAllRepositoryConfigs(): RepositoryConfig[] {
	const allGuidance = getRepoTestGuidanceList()
	return migrateGuidanceToConfig(allGuidance)
}

/**
 * Backward compatibility wrapper for existing code
 * @deprecated Use the new repository configuration system instead
 */
export function getLegacyGuidanceWrapper(instanceId: string): {
	guidance: RepoTestGuidance
	config: RepositoryConfig
	hasSpecificConfig: boolean
} {
	const guidance = getRepoTestGuidance(instanceId)
	const config = createRepositoryConfigFromInstance(instanceId)
	const hasSpecificConfig = hasRepositorySpecificConfig(instanceId)

	return {
		guidance,
		config,
		hasSpecificConfig,
	}
}

// Types are already exported above with their interface declarations

// SWE_BENCH_VERIFIED_REPOS and SWEBenchRepo are already exported above
