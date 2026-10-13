/**
 * Which stack operations show the full compose-log popover (#1558).
 *
 * Some users find the log popover on every start/stop noisy and just want the
 * buttons + a toast. This setting lists the operations for which the popover IS
 * shown; operations not in the list run "quiet" (toast only), and their log is
 * opened automatically only if the operation FAILS, so errors are never hidden.
 *
 * Stored as a JSON array of operation keys in the settings KV. Pure + shared so
 * the default, the key set, and the "should show?" decision are one source of
 * truth for the server, the store, and the stacks page.
 */
// Only operations that actually stream a compose log are listed. Remove is deliberately
// absent: it never opens the log popover (plain toast + error dialog), so a checkbox for it
// would control nothing.
export type StackLogOperation = 'start' | 'stop' | 'restart' | 'deploy' | 'down';

/** All operations, in display order, with a human label for the settings list. */
export const STACK_LOG_OPERATIONS: { key: StackLogOperation; label: string }[] = [
	{ key: 'start', label: 'Start' },
	{ key: 'stop', label: 'Stop' },
	{ key: 'restart', label: 'Restart / recreate' },
	{ key: 'deploy', label: 'Deploy / redeploy' },
	{ key: 'down', label: 'Down' }
];

const ALL_KEYS = STACK_LOG_OPERATIONS.map((o) => o.key);

/**
 * Default: show the log for everything EXCEPT the simple start/stop, matching the
 * 1.0.47 behavior for the heavier operations while giving start/stop the quiet
 * treatment the request asked for.
 */
export const DEFAULT_STACK_LOG_OPERATIONS: StackLogOperation[] = ['restart', 'deploy', 'down'];

/** Keep only valid, de-duplicated operation keys (defends the KV value + API body). */
export function sanitizeStackLogOperations(value: unknown): StackLogOperation[] {
	if (!Array.isArray(value)) return [...DEFAULT_STACK_LOG_OPERATIONS];
	const seen = new Set<StackLogOperation>();
	for (const v of value) {
		if (typeof v === 'string' && (ALL_KEYS as string[]).includes(v)) seen.add(v as StackLogOperation);
	}
	return ALL_KEYS.filter((k) => seen.has(k)); // canonical order
}

/** Whether the log popover should be shown for this operation. */
export function shouldShowStackLog(ops: StackLogOperation[], op: StackLogOperation): boolean {
	return ops.includes(op);
}

/**
 * Decode the stored KV value (a JSON array string) into the operation list. The
 * unset-vs-empty distinction is load-bearing: a null/absent value means the user never
 * touched the setting -> use the default; a stored "[]" means the user turned every op
 * off -> honor it as "log nothing" (NOT the default). Malformed JSON falls back to the
 * default rather than throwing.
 */
export function parseStackLogOperationsStorage(raw: string | null | undefined): StackLogOperation[] {
	if (raw == null) return [...DEFAULT_STACK_LOG_OPERATIONS];
	try {
		return sanitizeStackLogOperations(JSON.parse(raw));
	} catch {
		return [...DEFAULT_STACK_LOG_OPERATIONS];
	}
}
