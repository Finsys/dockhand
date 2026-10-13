// Scanner columns for the scan-all log. Only scanners that actually ran get a column (#1628).

export type ScannerId = 'grype' | 'trivy';

export const SCANNERS: readonly { id: ScannerId; label: string }[] = [
	{ id: 'grype', label: 'Grype' },
	{ id: 'trivy', label: 'Trivy' }
];

// Scanners with a result for at least one image, in the fixed SCANNERS order.
export function scannersInLog(entries: readonly { scanners: readonly { scanner: string }[] }[]) {
	const seen = new Set<string>();
	for (const e of entries) for (const s of e.scanners) seen.add(s.scanner);
	return SCANNERS.filter((sc) => seen.has(sc.id));
}
