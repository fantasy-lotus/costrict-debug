import { diffLines } from "diff"

export function getDiffLines(originalContent: string, newContent: string) {
	const diff = diffLines(originalContent, newContent)
	let changedLineCount = 0

	diff.forEach((part) => {
		if (part.added || part.removed) {
			// Use part.count if available, otherwise calculate manually
			if (part.count !== undefined) {
				changedLineCount += part.count
			} else {
				// Calculate line count manually
				const lines = part.value.split("\n")
				// If the last element is an empty string (due to trailing newline), don't count it
				const actualLineCount = part.value.endsWith("\n") ? lines.length - 1 : lines.length
				changedLineCount += actualLineCount
			}
		}
	})

	return changedLineCount
}
