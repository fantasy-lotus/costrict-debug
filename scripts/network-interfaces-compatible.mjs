export const networkInterfacesCompatible = `
const $__native_os__ = require("os");
const originalNetworkInterfaces = $__native_os__.networkInterfaces;

try {
	const test = originalNetworkInterfaces();
	if (!test || typeof test !== 'object') throw new Error('Invalid result');
} catch (err) {
	console.warn("⚠️ os.networkInterfaces() failed, applying fallback. Reason:", err.message);
	$__native_os__.networkInterfaces = function () {
		console.log("✅ [Patch] Custom os.networkInterfaces called");
		return {
			lo: [
				{
					address: '127.0.0.1',
					netmask: '255.0.0.0',
					family: 'IPv4',
					mac: '00:00:00:00:00:00',
					internal: true,
					cidr: '127.0.0.1/8'
				},
				{
					address: '::1',
					netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
					family: 'IPv6',
					mac: '00:00:00:00:00:00',
					internal: true,
					cidr: '::1/128',
					scopeid: 0
				}
			],
		};
	};
}
`
