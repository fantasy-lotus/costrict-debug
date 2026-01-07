import type { CommandId, CostrictCommandId, CodeActionId, TerminalActionId } from "@roo-code/types"

import { Package } from "../shared/package"

export const getCommand = (id: CommandId | CostrictCommandId) => `${Package.name}.${id}`

export const getCodeActionCommand = (id: CodeActionId) => `${Package.name}.${id}`

export const getTerminalCommand = (id: TerminalActionId) => `${Package.name}.${id}`
