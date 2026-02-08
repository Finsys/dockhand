/**
 * Formats a URL with proper IPv6 bracket handling.
 * IPv6 addresses must be wrapped in brackets in URLs.
 *
 * @example
 * formatHostPortUrl('192.168.1.1', 8080) // 'http://192.168.1.1:8080'
 * formatHostPortUrl('2001:db8::1', 8080) // 'http://[2001:db8::1]:8080'
 * formatHostPortUrl('localhost', 8080)   // 'http://localhost:8080'
 */
export function formatHostPortUrl(host: string, port: number): string {
	// Check if host is IPv6 (contains colons and is not already bracketed)
	const isIPv6 = host.includes(':') && !host.startsWith('[');
	const formattedHost = isIPv6 ? `[${host}]` : host;
	return `http://${formattedHost}:${port}`;
}
