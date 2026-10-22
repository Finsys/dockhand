// Console lines for one scan progress event. A scanner output line carries the
// status-bar `message` too, so only the output is logged for it (#1629).
export interface ScanProgressEvent {
	scanner?: string;
	message?: string;
	output?: string;
}

export function scanProgressLines(data: ScanProgressEvent): string[] {
	const scanner = data.scanner || 'dockhand';
	if (data.output) return [`[${scanner}] ${data.output}`];
	if (data.message) return [`[${scanner}] ${data.message}`];
	return [];
}
