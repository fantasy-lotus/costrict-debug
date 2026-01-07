import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

export function getIPCPath() {
	const sid = `${vscode?.env?.uriScheme || "vscode"}-costrict-login-sync`
	// Use a unique socket path for the IPC server
	return process.platform === "win32" ? `\\\\.\\pipe\\${sid}` : path.join(os.tmpdir(), `${sid}.sock`)
}
