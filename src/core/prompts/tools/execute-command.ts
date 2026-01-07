import { ToolArgs } from "./types"

export function getExecuteCommandDescription(args: ToolArgs): string | undefined {
	const swebenchExtra =
		args.mode === "swebench"
			? `\nSWE-bench / evaluation environments:\n- Commands may execute inside an evaluation container rather than on the host machine.\n- The repository workspace is typically at /workspace/repo. Prefer using cwd = "/workspace/repo" (or omit/leave null if the runner sets the correct default).\n- Do NOT attempt to install/upgrade dependencies or access the network unless explicitly permitted by the task.\n`
			: ""

	return `## execute_command
Description: Request to execute a CLI command on the system. Use this when you need to perform system operations or run specific commands to accomplish any step in the user's task. You must tailor your command to the user's system and provide a clear explanation of what the command does. For command chaining, use the appropriate chaining syntax for the user's shell. Prefer to execute complex CLI commands over creating executable scripts, as they are more flexible and easier to run. Prefer relative commands and paths that avoid location sensitivity for terminal consistency, e.g: \`touch ./testdata/example.file\`, \`dir ./examples/model1/data/yaml\`, or \`go test ./cmd/front --config ./cmd/front/config.yml\`. If directed by the user, you may open a terminal in a different directory by using the \`cwd\` parameter.${swebenchExtra}
Parameters:
- command: (required) The CLI command to execute. This should be valid for the current operating system. Ensure the command is properly formatted and does not contain any harmful instructions.
- cwd: (optional) The working directory to execute the command in (default: ${args.cwd}). If a protocol requires an explicit value, pass null when you want the default.
Usage:
<execute_command>
<command>Your command here</command>
<cwd>Working directory path (optional)</cwd>
</execute_command>

Example: Requesting to execute npm run dev
<execute_command>
<command>npm run dev</command>
</execute_command>

Example: Requesting to execute ls in a specific directory if directed
<execute_command>
<command>ls -la</command>
<cwd>/home/user/projects</cwd>
</execute_command>`
}
