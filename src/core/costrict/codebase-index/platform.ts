/**
 * Platform and architecture detector
 * Used to detect platform and architecture information of current runtime environment
 */
export class PlatformDetector {
	/**
	 * Get current platform information
	 * @returns Returns platform name: 'windows', 'darwin' or 'linux'
	 */
	get platform(): string {
		switch (process.platform) {
			case "win32":
				return "windows"
			case "darwin":
				return "darwin"
			default:
				return "linux"
		}
	}

	/**
	 * Get current architecture information
	 * @returns Returns architecture name: 'amd64' or 'arm64'
	 */
	get arch(): string {
		switch (process.arch) {
			case "ia32":
			case "x64":
				return "amd64"
			default:
				return "arm64"
		}
	}
}
