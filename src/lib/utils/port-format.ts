export interface PortMapping {
	publicPort: number;
	privatePort: number;
	display: string;
	isRange?: boolean;
}

interface PortInfo {
	PublicPort?: number;
	PrivatePort?: number;
	publicPort?: number;
	privatePort?: number;
}

/**
 * Format Docker port mappings, collapsing consecutive ranges of 3+ ports.
 * Accepts both Docker API format (PublicPort/PrivatePort) and camelCase (publicPort/privatePort).
 * e.g. 8080:8080, 8081:8081, 8082:8082 → 8080-8082:8080-8082
 * But 80:80, 81:81 stay as individual ports (only 2 consecutive).
 */
export function formatPorts(ports: PortInfo[] | undefined | null): PortMapping[] {
	if (!ports || ports.length === 0) return [];
	const seen = new Set<string>();
	const individual = ports
		.filter(p => (p.PublicPort || p.publicPort))
		.map(p => ({
			publicPort: p.PublicPort || p.publicPort!,
			privatePort: p.PrivatePort || p.privatePort!,
			display: `${p.PublicPort || p.publicPort}:${p.PrivatePort || p.privatePort}`
		}))
		.filter(p => {
			const key = p.display;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((a, b) => a.publicPort - b.publicPort);

	// Collapse consecutive port ranges (3+ ports only)
	if (individual.length <= 1) return individual;

	const result: PortMapping[] = [];
	let rangeStart = 0;
	let rangeEnd = 0;

	for (let i = 1; i < individual.length; i++) {
		const curr = individual[i];
		const start = individual[rangeStart];
		const prev = individual[rangeEnd];
		const offset = curr.publicPort - start.publicPort;
		const expectedPrivate = start.privatePort + offset;
		if (curr.publicPort === prev.publicPort + 1 && curr.privatePort === expectedPrivate) {
			rangeEnd = i;
		} else {
			flushRange(individual, rangeStart, rangeEnd, result);
			rangeStart = i;
			rangeEnd = i;
		}
	}
	flushRange(individual, rangeStart, rangeEnd, result);

	return result;
}

function flushRange(items: PortMapping[], start: number, end: number, result: PortMapping[]) {
	const rangeLen = end - start + 1;
	if (rangeLen >= 3) {
		// Collapse into range
		result.push({
			publicPort: items[start].publicPort,
			privatePort: items[start].privatePort,
			display: `${items[start].publicPort}-${items[end].publicPort}:${items[start].privatePort}-${items[end].privatePort}`,
			isRange: true
		});
	} else {
		// Keep as individual ports
		for (let i = start; i <= end; i++) {
			result.push(items[i]);
		}
	}
}
