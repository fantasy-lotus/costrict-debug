import * as fs from "fs"

import { run, command, option, flag, number, boolean, string } from "cmd-ts"

import { EVALS_REPO_PATH } from "../exercises/index.js"

import { runCi } from "./runCi.js"
import { runEvals } from "./runEvals.js"
import { processTask, processTaskForSwe } from "./runTask.js"

const main = async () => {
	await run(
		command({
			name: "cli",
			description: "Execute an eval run.",
			version: "0.0.0",
			args: {
				ci: flag({ type: boolean, long: "ci", defaultValue: () => false }),
				runId: option({ type: number, long: "runId", short: "r", defaultValue: () => -1 }),
				taskId: option({ type: number, long: "taskId", short: "t", defaultValue: () => -1 }),
				instanceId: option({ type: string, long: "instance-id", defaultValue: () => "" }),
				workspacePath: option({ type: string, long: "workspace-path", defaultValue: () => "" }),
				promptFile: option({ type: string, long: "prompt-file", defaultValue: () => "" }),
				mode: option({ type: string, long: "mode", defaultValue: () => "swebench" }),
				apiProvider: option({ type: string, long: "api-provider", defaultValue: () => "zgsm" }),
				zgsmCodeMode: option({ type: string, long: "zgsm-code-mode", defaultValue: () => "vibe" }),
				timeoutMs: option({ type: number, long: "timeout-ms", defaultValue: () => 5 * 60 * 1000 }),
			},
			handler: async (args) => {
				const {
					runId,
					taskId,
					ci,
					instanceId,
					workspacePath,
					promptFile,
					mode,
					apiProvider,
					zgsmCodeMode,
					timeoutMs,
				} = args

				try {
					const isSweMode = Boolean(instanceId && workspacePath && promptFile)
					const needsExercisesRepo = Boolean(ci || runId !== -1 || taskId !== -1)
					if (!isSweMode && needsExercisesRepo && !fs.existsSync(EVALS_REPO_PATH)) {
						console.error(
							`Exercises do not exist at ${EVALS_REPO_PATH}. Please run "git clone https://github.com/RooCodeInc/Roo-Code-Evals.git evals".`,
						)
						process.exitCode = 1
						return
					}

					if (ci) {
						await runCi({ concurrency: 3, exercisesPerLanguage: 5 })
					} else if (runId !== -1) {
						await runEvals(runId)
					} else if (taskId !== -1) {
						await processTask({ taskId, jobToken: process.env.ROO_CODE_CLOUD_TOKEN || null })
					} else if (instanceId && workspacePath && promptFile) {
						// SWE task mode with direct parameters
						const prompt = fs.readFileSync(promptFile, "utf-8")
						await processTaskForSwe({
							instanceId,
							workspacePath,
							prompt,
							mode,
							apiProvider,
							zgsmCodeMode,
							timeoutMs,
						})
					} else {
						throw new Error(
							"Either runId, taskId, or (instanceId + workspacePath + promptFile) must be provided.",
						)
					}
				} catch (error) {
					console.error(error)
					process.exitCode = 1
					return
				}
			},
		}),
		process.argv.slice(2),
	)
}
main()
