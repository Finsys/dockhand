// A Dockhand that listens beyond localhost with authentication off and the Docker
// socket mounted read-write is one unauthenticated request from host takeover. This
// is the exact shape of the GHSA-r3mg incident. The warning fires only on all three
// together, so a normal install (behind a proxy, on a LAN/VPN, or with auth on) stays
// quiet. An unknown socket state (self-inspect failed) never warns - no false alarm.

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '0:0:0:0:0:0:0:1']);

/** Whether the bind host keeps the server off other interfaces. Empty counts as local. */
export function isLoopbackHost(host: string): boolean {
	const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
	return h === '' || LOOPBACK.has(h);
}

export interface ExposureInput {
	authEnabled: boolean;
	host: string;
	/** Docker socket mounted read-write; null when it could not be determined. */
	dockerSocketRW: boolean | null;
}

/** True only when all three risk conditions hold; an unknown socket state never warns. */
export function shouldWarnExposure({ authEnabled, host, dockerSocketRW }: ExposureInput): boolean {
	return !authEnabled && !isLoopbackHost(host) && dockerSocketRW === true;
}
