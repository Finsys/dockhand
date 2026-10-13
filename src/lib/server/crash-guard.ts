// Process-level safety net: a rejected promise that nothing awaits (e.g. an aborted
// streaming Docker request surfacing UND_ERR_BODY_TIMEOUT from undici's internals) would
// otherwise reach Node's default handler and terminate the whole server. Dockhand is a
// long-lived process serving many independent operations, so one background failure must
// not take everything down. Log it loudly (so it is never silent) and keep running.
//
// Scope is deliberately narrow: ONLY unhandledRejection. uncaughtException is left to
// Node's default (crash) - after a genuine uncaught throw the process state is undefined
// and continuing is unsafe; a rejected promise carries no such guarantee-of-corruption.
//
// Side-effect module: import once, as early as possible.

/**
 * Turn a rejection reason into the lines to log. Pure so it can be unit-tested without
 * registering a real process listener. Never throws.
 */
export function formatUnhandledRejection(reason: unknown): string[] {
	const err = reason instanceof Error ? reason : new Error(String(reason));
	const code = (err as NodeJS.ErrnoException).code;
	const lines = [
		`[crash-guard] Unhandled promise rejection (process kept alive)${code ? ` [${code}]` : ''}: ${err.message}`
	];
	if (err.stack) lines.push(err.stack);
	const cause = (err as Error & { cause?: unknown }).cause;
	if (cause) lines.push(`[crash-guard] caused by: ${cause instanceof Error ? cause.stack || cause.message : String(cause)}`);
	return lines;
}

let installed = false;

export function installCrashGuard(): void {
	if (installed) return;
	installed = true;
	process.on('unhandledRejection', (reason: unknown) => {
		for (const line of formatUnhandledRejection(reason)) console.error(line);
	});
}

installCrashGuard();
