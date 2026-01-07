export const joinUrl = (url: string, paths: string[] = []) => {
	if (!url) {
		console.error("[joinUrl] url is required")
		return ""
	}

	if (!paths?.length) {
		return url
	}

	return [
		`${url.endsWith("/") ? url.slice(0, -1) : url}`,
		...paths.map((path) => (path.startsWith("/") ? path.slice(1) : path)),
	].join("/")
}
