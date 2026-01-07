import type OpenAI from "openai"

const EXECUTE_COMMAND_DESCRIPTION = `Request to execute a CLI command on the system.

Use this tool when you need to run commands to gather evidence, run tests, or perform system operations needed to complete the task.

General guidance:
- Provide a clear explanation of what the command does.
- For command chaining, use the appropriate chaining syntax for the user's shell.
- Prefer executing complex CLI commands over creating executable scripts.

Parameters:
- command: (required) The CLI command to execute.
- cwd: (required; may be null) The working directory to execute the command in.

Example: Executing npm run dev
{ "command": "npm run dev", "cwd": null }

Example: Executing ls in a specific directory if directed
{ "command": "ls -la", "cwd": "/home/user/projects" }

Example: Using relative paths
{ "command": "touch ./testdata/example.file", "cwd": null }`

const COMMAND_PARAMETER_DESCRIPTION = `Shell command to execute`

const CWD_PARAMETER_DESCRIPTION = `Working directory for the command (string or null)`

export default {
	type: "function",
	function: {
		name: "execute_command",
		description: EXECUTE_COMMAND_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: COMMAND_PARAMETER_DESCRIPTION,
				},
				cwd: {
					type: ["string", "null"],
					description: CWD_PARAMETER_DESCRIPTION,
				},
			},
			required: ["command", "cwd"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
