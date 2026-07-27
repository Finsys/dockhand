/**
 * Pure, UI-free backup execution-history logic. Kept out of utils/backup.ts (which
 * pulls in lucide/cloud-icons) so it can be unit-tested under `bun test` — matches
 * the repo's convention of isolating logic from Svelte/icon imports.
 */

export interface Execution {
	id: number;
	scheduleId?: number;
	triggeredAt: string | null;
	triggeredBy: string;
	status: string;
	duration: number | null;
	errorMessage: string | null;
	logs?: string | null;
	details?: { filesNew?: number; filesChanged?: number; dataAdded?: number } | null;
	/** Stamped by fetchBackupExecutions when a config→destination map is passed, so
	 *  the history table can show which repo each run wrote to. */
	_repository?: string;
	_destinationName?: string;
}

export interface ExecutionTally {
	executions: Execution[];
	ok: number;      // success + warning + skipped — produced a snapshot or was a no-op
	failed: number;  // status === 'failed'
}

/**
 * Sort executions newest-first and count the ok/fail tally. `warning` and `skipped`
 * count as ok — only a hard `failed` is red. `running`/`queued` count as neither
 * (in-flight, no outcome yet). A null `triggeredAt` sorts oldest.
 */
export function computeExecutionTally(executions: Execution[]): ExecutionTally {
	const sorted = [...executions].sort(
		(a, b) => new Date(b.triggeredAt ?? 0).getTime() - new Date(a.triggeredAt ?? 0).getTime()
	);
	let ok = 0, failed = 0;
	for (const e of sorted) {
		if (e.status === 'failed') failed++;
		else if (e.status === 'success' || e.status === 'warning' || e.status === 'skipped') ok++;
	}
	return { executions: sorted, ok, failed };
}
