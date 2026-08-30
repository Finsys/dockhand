import { mock } from 'bun:test';

/**
 * Shared registration point for faking `$lib/server/db`.
 *
 * $lib/server/db can't be imported for real under Bun (it transitively loads
 * better-sqlite3, which throws ERR_DLOPEN_FAILED), so every test file that
 * exercises a route/module built on top of it has to fake the whole thing.
 *
 * Two Bun behaviours make a naive shared registry fail, both confirmed
 * empirically (undocumented):
 *
 * 1. mock.module() replaces a module's exports WHOLESALE for the ENTIRE test
 *    process -- no per-file scoping without `bun test --isolate` (not used
 *    by this suite). Two files independently calling
 *    `mock.module('$lib/server/db', () => ({ onlyWhatIMeed }))` clobber each
 *    other completely -- whichever registers "later" wins for BOTH files.
 *
 * 2. Bun does not evaluate every test file's top-level code before running
 *    any test body. It runs files one at a time. The FIRST time ANY code,
 *    from ANY file, resolves the `$lib/server/db` specifier (`import(...)`
 *    or a static import chain reaching it), Bun freezes the resulting module
 *    namespace object for the specifier -- confirmed by trying (a) a Proxy
 *    that reads a shared, still-mutable bag live, and (b) re-calling
 *    mock.module() with a fresh object literal right before each file's own
 *    import: neither picks up a key added by a file that runs AFTER the
 *    first-ever resolution. Once resolved, a specifier's export set is fixed
 *    for the rest of the process, no matter how many more times
 *    mock.module() is called for it afterwards.
 *
 * The fix that DOES work: pre-declare every export name any test file will
 * ever need, ONCE, right here, each as a thin dispatcher function that looks
 * up its real implementation in `impls` AT CALL TIME (not at import time).
 * These dispatcher functions themselves are stable references, present in
 * the very first module snapshot regardless of which file resolves the
 * specifier first. `registerDbFake(name, fn)` only ever changes what a
 * dispatcher DELEGATES to -- it never needs to add a new key to the frozen
 * snapshot, so it works no matter which file calls it, or when.
 *
 * Adding a new $lib/server/db export a test needs? Add its name to
 * KNOWN_EXPORTS below, then call `registerDbFake('yourExportName', fn)` from
 * your test file. Do NOT add a separate `mock.module('$lib/server/db', ...)`
 * or `mock.module('.../db', ...)` call anywhere else in the suite -- that
 * reintroduces the collision this file exists to avoid.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

/** Every $lib/server/db export any test file fakes, across the whole suite. */
const KNOWN_EXPORTS = [
	'getBackupConfig',
	'getScheduleExecution',
	'deleteScheduleExecution',
	'getScheduleExecutions',
	'getDeployLogReconcileEnabled',
	'getScheduleExecutionIdsByType',
	'createScheduleExecution',
	'updateScheduleExecution',
	'appendScheduleExecutionLog'
] as const;

const impls: Record<string, AnyFn> = {};

export function registerDbFake(name: (typeof KNOWN_EXPORTS)[number], fn: AnyFn): void {
	impls[name] = fn;
}

function dispatcher(name: string): AnyFn {
	return (...args: unknown[]) => {
		const impl = impls[name];
		if (!impl) {
			throw new Error(
				`db-fake: '${name}' was called but no test file has registered an implementation for it yet ` +
					`(registerDbFake('${name}', ...) must run before the test that calls it)`
			);
		}
		return impl(...args);
	};
}

const moduleShape: Record<string, AnyFn> = {};
for (const name of KNOWN_EXPORTS) {
	moduleShape[name] = dispatcher(name);
}

mock.module('$lib/server/db', () => moduleShape);
