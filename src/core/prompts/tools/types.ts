import { DiffStrategy } from "../../../shared/tools"
import { McpHub } from "../../../services/mcp/McpHub"

export type ToolArgs = {
	mode?: string
	cwd: string
	supportsComputerUse: boolean
	diffStrategy?: DiffStrategy
	browserViewportSize?: string
	mcpHub?: McpHub
	toolOptions?: any
	partialReadsEnabled?: boolean
	settings?: Record<string, any>
	experiments?: Record<string, boolean>
}
