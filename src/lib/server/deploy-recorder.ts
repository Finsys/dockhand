// src/lib/server/deploy-recorder.ts
/**
 * Decides what may be written to a persisted deploy log.
 *
 * Only redacted output lines qualify. The 'result' event is excluded on purpose: it
 * carries result.output (and, on the compose endpoint, result.error) -- compose's raw
 * stdout/stderr, which never passes through redactLine. Persisting it would turn a
 * ten-minute in-memory buffer into a permanent plaintext archive on disk.
 *
 * BOTH conditions below are load-bearing and are covered by separate tests. Do not
 * collapse them into the type check alone: that would admit any future event carrying
 * type: 'line', and no test would notice.
 */
export function shouldRecord(event: string | undefined, data: unknown): boolean {
	if (event !== 'progress') return false;
	if (typeof data !== 'object' || data === null) return false;
	return (data as { type?: string }).type === 'line';
}
