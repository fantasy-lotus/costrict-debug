import * as vscode from "vscode"

/**
 * Comment thread information interface
 */
export interface CommentThreadInfo {
	/** Unique issue identifier */
	issueId: string
	/** File URI */
	fileUri: vscode.Uri
	/** Code range */
	range: vscode.Range
	/** Comment object (provided externally) */
	comment: vscode.Comment
}
