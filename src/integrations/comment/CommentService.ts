import * as vscode from "vscode"
import { CommentThreadInfo } from "./types"
import { t } from "../../i18n"

/**
 * Comment Service Class - Manages VS Code editor comment system integration
 * Focuses on pure editor comment UI operations, does not handle business logic
 */
export class CommentService {
	private static instance: CommentService | null = null
	private commentController: vscode.CommentController | null = null
	private threadMap: Map<string, WeakRef<vscode.CommentThread>> = new Map()

	private constructor() {}

	/**
	 * Get CommentService singleton instance
	 */
	public static getInstance(): CommentService {
		if (!CommentService.instance) {
			CommentService.instance = new CommentService()
		}
		return CommentService.instance
	}

	/**
	 * Initialize comment service
	 */
	public async initialize(): Promise<void> {
		// Check if already initialized
		if (this.commentController) {
			return
		}

		try {
			// Create CommentController
			this.commentController = vscode.comments.createCommentController(
				"costrict-code-review",
				"costrict Code Review",
			)
			console.log("[CommentService] CommentController initialized")
		} catch (error) {
			console.error("[CommentService] Failed to initialize CommentController:", error)
			throw error
		}
	}

	/**
	 * Dispose comment service
	 */
	public async dispose(): Promise<void> {
		try {
			// Clear all comment threads first
			await this.clearAllCommentThreads()

			// Dispose the comment controller
			if (this.commentController) {
				this.commentController.dispose()
				this.commentController = null
			}

			// Reset singleton instance
			CommentService.instance = null

			console.log("[CommentService] CommentService disposed")
		} catch (error) {
			console.error("[CommentService] Failed to dispose CommentService:", error)
			// Force cleanup even if some operations failed
			this.commentController = null
			CommentService.instance = null
			this.threadMap.clear()
		}
	}

	/**
	 * Focus or create comment thread
	 */
	public async focusOrCreateCommentThread(commentThreadInfo: CommentThreadInfo): Promise<void> {
		try {
			// Check if thread already exists
			const existingThread = this.getCommentThread(commentThreadInfo.issueId)
			if (existingThread) {
				await this.focusExistingThread(existingThread, commentThreadInfo.fileUri, commentThreadInfo.range)
				return
			}

			// Ensure CommentController is initialized
			if (!this.commentController) {
				await this.initialize()
			}

			// Create new comment thread
			const thread = this.commentController!.createCommentThread(
				commentThreadInfo.fileUri,
				commentThreadInfo.range,
				[commentThreadInfo.comment],
			)

			// Configure thread properties
			this.configureCommentThread(thread)

			// Store new thread's weak reference in threadMap
			this.threadMap.set(commentThreadInfo.issueId, new WeakRef(thread))

			// Focus on newly created thread
			await this.focusExistingThread(thread, commentThreadInfo.fileUri, commentThreadInfo.range)

			console.log(`[CommentService] Created and focused comment thread for issue ${commentThreadInfo.issueId}`)
		} catch (error) {
			console.error(
				`[CommentService] Failed to focus or create comment thread for issue ${commentThreadInfo.issueId}:`,
				error,
			)
			throw error
		}
	}

	/**
	 * Clear all comment threads
	 */
	public async clearAllCommentThreads(): Promise<void> {
		try {
			// Get all thread IDs
			const threadIds = Array.from(this.threadMap.keys())
			let disposedCount = 0

			// Dispose each thread
			for (const issueId of threadIds) {
				const thread = this.getCommentThread(issueId)
				if (thread) {
					try {
						thread.dispose()
						disposedCount++
					} catch (error) {
						console.error(`[CommentService] Failed to dispose thread ${issueId}:`, error)
					}
				}
			}

			// Clear the entire threadMap
			this.threadMap.clear()

			console.log(`[CommentService] Cleared all comment threads (disposed ${disposedCount} threads)`)
		} catch (error) {
			console.error("[CommentService] Failed to clear all comment threads:", error)
			// Force clear the map even if some disposals failed
			this.threadMap.clear()
		}
	}

	/**
	 * Get specified comment thread
	 */
	public getCommentThread(issueId: string): vscode.CommentThread | null {
		// Get WeakRef from threadMap
		const threadRef = this.threadMap.get(issueId)
		if (!threadRef) {
			return null
		}

		// Get actual thread object from WeakRef
		const thread = threadRef.deref()
		if (!thread) {
			// Thread has been garbage collected, remove from map
			this.threadMap.delete(issueId)
			return null
		}

		// Check if thread is still valid (not disposed)
		try {
			// Access a property to check if thread is still valid
			// If thread is disposed, accessing properties may throw or return undefined
			if (thread.uri && thread.range) {
				return thread
			} else {
				// Thread appears to be disposed, remove from map
				this.threadMap.delete(issueId)
				return null
			}
		} catch (error) {
			// Thread is disposed or invalid, remove from map
			this.threadMap.delete(issueId)
			return null
		}
	}

	/**
	 * Update comment thread collapsible state by issue ID
	 *
	 * @param issueId - Issue ID to find the comment thread
	 * @param state - New collapsible state to set
	 * @returns Promise<boolean> - Returns true if successfully updated, false if thread not found
	 */
	private async updateCommentThreadCollapsibleState(
		issueId: string,
		state: vscode.CommentThreadCollapsibleState,
	): Promise<boolean> {
		try {
			// Get the thread using our getter method
			const thread = this.getCommentThread(issueId)

			if (!thread) {
				console.warn(`[CommentService] Comment thread not found for issue ${issueId}`)
				return false
			}

			// Update the collapsible state
			thread.collapsibleState = state

			console.log(
				`[CommentService] Updated collapsible state for issue ${issueId} to ${state === vscode.CommentThreadCollapsibleState.Expanded ? "Expanded" : "Collapsed"}`,
			)
			return true
		} catch (error) {
			console.error(`[CommentService] Failed to update collapsible state for issue ${issueId}:`, error)
			return false
		}
	}

	/**
	 * Expand comment thread by issue ID
	 *
	 * @param issueId - Issue ID to find the comment thread
	 * @returns Promise<boolean> - Returns true if successfully expanded, false if thread not found
	 */
	public async expandCommentThread(issueId: string): Promise<boolean> {
		return await this.updateCommentThreadCollapsibleState(issueId, vscode.CommentThreadCollapsibleState.Expanded)
	}

	/**
	 * Collapse comment thread by issue ID
	 *
	 * @param issueId - Issue ID to find the comment thread
	 * @returns Promise<boolean> - Returns true if successfully collapsed, false if thread not found
	 */
	public async collapseCommentThread(issueId: string): Promise<boolean> {
		return await this.updateCommentThreadCollapsibleState(issueId, vscode.CommentThreadCollapsibleState.Collapsed)
	}

	/**
	 * Configure comment thread properties
	 */
	private configureCommentThread(thread: vscode.CommentThread): void {
		thread.contextValue = "CostrictCodeReview"
		thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded
		thread.canReply = false
		thread.label = t("common:review.comment.detail_label")
	}

	/**
	 * Focus existing comment thread
	 */
	private async focusExistingThread(
		thread: vscode.CommentThread,
		fileUri: vscode.Uri,
		range: vscode.Range,
	): Promise<void> {
		await this.openFileAndFocus(fileUri, range)
		this.ensureThreadFocus(thread)
	}

	/**
	 * Open file and focus on the specified range
	 */
	private async openFileAndFocus(fileUri: vscode.Uri, range: vscode.Range): Promise<void> {
		try {
			const document = await vscode.workspace.openTextDocument(fileUri)
			const editor = await vscode.window.showTextDocument(document)
			editor.revealRange(range, vscode.TextEditorRevealType.InCenter)
			editor.selection = new vscode.Selection(range.start, range.end)
			console.log(`[CommentService] Opened and focused file: ${fileUri.fsPath}`)
		} catch (error) {
			console.error(`[CommentService] Failed to open and focus file: ${fileUri?.fsPath || "unknown"}`, error)
			throw error
		}
	}

	/**
	 * Ensure thread focus by setting expanded state
	 */
	private ensureThreadFocus(thread: vscode.CommentThread): void {
		// VS Code API doesn't have direct thread focus method
		// Focus is achieved through opening file and positioning range
		thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded
	}
}
