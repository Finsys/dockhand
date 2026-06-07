/**
 * Parse Docker port mapping syntax from UI inputs.
 *
 * Supported host port formats:
 *   "8080"              -> { hostIp: '', hostPort: '8080' }
 *   "127.0.0.1:8080"   -> { hostIp: '127.0.0.1', hostPort: '8080' }
 *   "::1:8080"          -> { hostIp: '::1', hostPort: '8080' }
 *   "[::1]:8080"        -> { hostIp: '::1', hostPort: '8080' }
 *   ""                  -> { hostIp: '', hostPort: '' }  (empty = random)
 *
 * Supported container port formats:
 *   "8080"              -> single port
 *   "8000-8005"         -> port range
 */

export interface ParsedHostPort {
	hostIp: string;
	hostPort: string;
}

/**
 * Parse a host port string that may include an IP binding.
 * Returns the IP and port separately.
 */
export function parseHostPort(input: string): ParsedHostPort {
	const trimmed = input.trim();
	if (!trimmed) return { hostIp: '', hostPort: '' };

	// Check for bracketed IPv6: [::1]:8080
	const bracketMatch = trimmed.match(/^\[([^\]]+)\]:(.+)$/);
	if (bracketMatch) {
		return { hostIp: bracketMatch[1], hostPort: bracketMatch[2] };
	}

	// Count colons to distinguish IPv4:port from IPv6
	const colons = (trimmed.match(/:/g) || []).length;

	if (colons === 0) {
		// Just a port number or range: "8080" or "8000-8005"
		return { hostIp: '', hostPort: trimmed };
	}

	if (colons === 1) {
		// IPv4:port -> "127.0.0.1:8080"
		const lastColon = trimmed.lastIndexOf(':');
		return {
			hostIp: trimmed.substring(0, lastColon),
			hostPort: trimmed.substring(lastColon + 1)
		};
	}

	// Multiple colons — ambiguous between IPv6 address and IPv6:port.
	// Use bracket notation [::1]:8080 for IPv6 with port.
	// Bare multi-colon input is treated as IPv6 address with no port.
	return { hostIp: trimmed, hostPort: '' };
}

/**
 * Validate a port number or range string.
 * Returns error message or empty string if valid.
 */
export function validatePort(port: string): string {
	if (!port) return ''; // Empty is valid (means random allocation)

	// Port range: "8000-8005"
	const rangeMatch = port.match(/^(\d+)-(\d+)$/);
	if (rangeMatch) {
		const start = parseInt(rangeMatch[1]);
		const end = parseInt(rangeMatch[2]);
		if (start < 1 || start > 65535) return `Port ${start} out of range (1-65535)`;
		if (end < 1 || end > 65535) return `Port ${end} out of range (1-65535)`;
		if (start >= end) return 'Range start must be less than end';
		return '';
	}

	// Single port
	if (!/^\d+$/.test(port)) return 'Invalid port number';
	const num = parseInt(port);
	if (num < 1 || num > 65535) return 'Port out of range (1-65535)';
	return '';
}

/**
 * Validate an IP address (IPv4 or IPv6).
 * Returns error message or empty string if valid.
 */
export function validateIp(ip: string): string {
	if (!ip) return ''; // Empty is valid (bind to all interfaces)

	// Basic IPv4 check
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
		const parts = ip.split('.').map(Number);
		if (parts.every(p => p >= 0 && p <= 255)) return '';
		return 'Invalid IPv4 address';
	}

	// IPv6 (simplified check — accept common forms)
	if (/^[0-9a-fA-F:]+$/.test(ip)) return '';

	return 'Invalid IP address';
}

/**
 * Expand port range mappings into individual Docker API port bindings.
 *
 * Input: hostPort="8000-8005", containerPort="9000-9005", protocol="tcp", hostIp=""
 * Output: { "9000/tcp": { HostPort: "8000" }, "9001/tcp": { HostPort: "8001" }, ... }
 */
export function expandPortBindings(
	hostPort: string,
	containerPort: string,
	protocol: string,
	hostIp: string
): Record<string, { HostIp?: string; HostPort: string }> {
	const result: Record<string, { HostIp?: string; HostPort: string }> = {};

	const hostRange = parseRange(hostPort);
	const containerRange = parseRange(containerPort);

	if (hostRange && containerRange) {
		// Both are ranges — must be same length
		const len = Math.min(hostRange.length, containerRange.length);
		for (let i = 0; i < len; i++) {
			const key = `${containerRange[i]}/${protocol}`;
			const binding: { HostIp?: string; HostPort: string } = { HostPort: String(hostRange[i]) };
			if (hostIp) binding.HostIp = hostIp;
			result[key] = binding;
		}
	} else if (containerRange) {
		// Container is range, host is single port or empty
		for (const cp of containerRange) {
			const key = `${cp}/${protocol}`;
			const binding: { HostIp?: string; HostPort: string } = { HostPort: hostPort || '0' };
			if (hostIp) binding.HostIp = hostIp;
			result[key] = binding;
		}
	} else {
		// Single port mapping
		const key = `${containerPort}/${protocol}`;
		const binding: { HostIp?: string; HostPort: string } = { HostPort: hostPort || '0' };
		if (hostIp) binding.HostIp = hostIp;
		result[key] = binding;
	}

	return result;
}

function parseRange(port: string): number[] | null {
	const match = port.match(/^(\d+)-(\d+)$/);
	if (!match) return null;
	const start = parseInt(match[1]);
	const end = parseInt(match[2]);
	const result: number[] = [];
	for (let i = start; i <= end; i++) result.push(i);
	return result;
}

/**
 * Format a parsed host port back to display string.
 */
export function formatHostPort(hostIp: string, hostPort: string): string {
	if (!hostIp) return hostPort;
	// IPv6 needs brackets
	if (hostIp.includes(':')) return `[${hostIp}]:${hostPort}`;
	return `${hostIp}:${hostPort}`;
}
