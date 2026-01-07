/**
 * SWE-bench Submit Review System
 *
 * Implements a submission review blocker for SWE-bench mode.
 * On first attempt_completion, returns a checklist reminder via tool result.
 * On second attempt_completion, allows submission to proceed.
 *
 * Also implements first modification guidance for SWE-bench mode.
 * On first apply_diff in ANALYZE phase, returns guidance via tool result.
 */

import type { Task } from "../task/Task"

/**
 * SWE-bench submission review checklist
 */
export const SWEBENCH_REVIEW_CHECKLIST = `
Before submitting, please verify:
1. FAIL_TO_PASS tests now pass
2. PASS_TO_PASS tests still pass  
3. No temporary/debug scripts or print statements left
4. Changes focus on solving the real problem (not test manipulation)
5. Changes are minimal and focused on the specific issue
`.trim()

/**
 * SWE-bench first modification guidance
 * This message is shown when blocking the first modification attempt
 */
export const SWEBENCH_FIRST_MODIFICATION_GUIDANCE = `
💡 SWE-bench Guidance: First modification attempt detected in ANALYZE phase.

⚠️  MODIFICATION BLOCKED - Please follow this systematic approach first:

0. **Re-anchor with MCP sequential-thinking (recommended)**
   - Call MCP sequential-thinking once before patching to structure the problem and rank hypotheses
   - Suggested: totalThoughts = 3 (easy), 5 (medium), 8-12 (hard)

1. **Understand the problem** - Read issue description and check error messages
2. **Check test existence** - Verify if FAIL_TO_PASS tests exist or need creation  
3. **Explore relevant code** - Find implementation files related to the issue
4. **Run existing tests** - Execute tests to understand current failure patterns
5. **Create/modify tests** - If tests don't exist or need updates
6. **Implement solution** - Make minimal changes to fix the issue
7. **Verify fix** - Run tests to confirm FAIL_TO_PASS pass and PASS_TO_PASS still pass

📋 NEXT STEPS:
- If you need to create NEW test files that don't exist yet, call apply_diff again
- If you want to modify existing code, first run the FAIL_TO_PASS tests to understand the failure
- After understanding the problem, call apply_diff again to proceed with your modification

This guidance is provided once per task to help you follow SWE-bench best practices.
`.trim()

/**
 * Check if first modification guidance should be shown and block the operation
 * Returns true if this is the first apply_diff in ANALYZE phase without running tests
 * Also marks the guidance as shown so the next call will proceed
 */
export function shouldShowFirstModificationGuidance(task: Task): boolean {
	const stateMachine = task.swebenchInterceptor?.getStateMachine()
	if (!stateMachine) {
		return false
	}

	// Use the state machine's method to check and mark
	if (stateMachine.shouldShowFirstModificationGuidance()) {
		// Mark as shown so the next call will proceed
		stateMachine.markFirstModificationGuidanceShown()
		return true
	}

	return false
}

/**
 * Get the first modification guidance message
 * This message blocks the modification and instructs agent to retry after reading
 */
export function getFirstModificationGuidance(): string {
	return `⛔ FIRST MODIFICATION BLOCKED

${SWEBENCH_FIRST_MODIFICATION_GUIDANCE}

---
Your modification has been blocked. Please review the guidance above.
To proceed with your modification (e.g., creating new test files), call apply_diff again.`
}

/**
 * Get the review reminder message for first attempt_completion
 */
export function getSWEBenchReviewReminder(modifiedTestFiles?: string[]): string {
	let testFileWarning = ""

	if (modifiedTestFiles && modifiedTestFiles.length > 0) {
		testFileWarning = `

�  NOTE: Test file modifications detected

You have modified the following test files:
${modifiedTestFiles.map((f) => `  - ${f}`).join("\n")}

⚠️  Remember: Focus on solving the real problem, not gaming the tests
• If you added legitimate test cases to validate your solution, that's fine
• But avoid changing existing test expectations just to make tests pass
• The goal is correct implementation that naturally passes tests
`
	}

	return `⚠️  SUBMISSION REVIEW REQUIRED
${testFileWarning}
Before submitting your solution, please verify:

❓ FAIL_TO_PASS tests now pass (VERIFICATION NEEDED)
❓ PASS_TO_PASS tests still pass (VERIFICATION NEEDED)
❓ Working tree contains a non-empty git diff of your code changes
❓ Your branch has not been switched during the run (stay on original instance branch)
✅ No temporary/debug scripts or print statements left  
✅ Changes focus on solving the real problem (not test manipulation)
✅ Changes are minimal and focused on the specific issue

🔍 NEXT STEP: Verify PASS_TO_PASS tests still pass, and review your code-changes

⚠️  IMPORTANT: DO NOT GIVE UP, please persist with your bug fix. Try paths you haven't considered before, and ensure you leave your code changes in the repository for evaluation.

After verification succeeds, call attempt_completion again to submit.`
}

/**
 * Check if this is the first attempt_completion call (should show reminder)
 * Returns true if reminder should be shown, false if submission should proceed
 */
export function shouldShowSWEBenchReviewReminder(task: Task): boolean {
	const stateMachine = task.swebenchInterceptor?.getStateMachine()
	if (!stateMachine) {
		return false
	}

	const state = stateMachine.getState()

	// Show reminder only on first attempt_completion when modifications were made
	// attemptCompletionCount is incremented BEFORE this check in recordToolUse
	// So count === 1 means this is the first call
	return state.attemptCompletionCount === 1 && state.modificationCount > 0
}

/**
 * Check if any test files have been modified
 */
export function hasModifiedTestFiles(task: Task): string[] {
	const stateMachine = task.swebenchInterceptor?.getStateMachine()
	if (!stateMachine) {
		return []
	}

	const state = stateMachine.getState()
	return state.modifiedFiles.filter((filePath: string) => isTestFile(filePath))
}

/**
 * Import isTestFile function from state-machine
 */
import { isTestFile } from "./state-machine"

/**
 * Check if SWE-bench submit review should be enforced
 * @deprecated Use shouldShowSWEBenchReviewReminder instead
 */
export function shouldEnforceSWEBenchReview(task: Task): boolean {
	return shouldShowSWEBenchReviewReminder(task)
}

/**
 * @deprecated No longer needed - review is handled via tool result
 */
export function hasConfirmedSWEBenchReview(_task: Task): boolean {
	return true // Always return true to not block
}

/**
 * @deprecated No longer needed - review is handled via tool result
 */
export async function showSWEBenchSubmitReview(_task: Task): Promise<boolean> {
	return true
}
