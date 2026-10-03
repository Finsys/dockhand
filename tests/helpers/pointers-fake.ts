import { mock } from 'bun:test';
import * as real from '$lib/server/stack-source-pointers';

/**
 * Shared registration point for faking `$lib/server/stack-source-pointers`.
 *
 * Same collision problem tests/helpers/db-fake.ts documents for $lib/server/db:
 * mock.module() replaces a module's exports WHOLESALE for the entire test
 * process, and Bun freezes the exported shape the first time ANY file resolves
 * the specifier -- so a second, independent mock.module call elsewhere in the
 * suite would silently clobber (or be clobbered by) this one.
 *
 * Why the fallback design: the REAL module is side-effect-free at import time
 * (its db-touching functions lazily `await import('./db/drizzle.js')` inside
 * the function body), so importing it here is safe. Route-level tests fake the
 * two runtime accessors (readStackSourcePointer / upsertStackSourcePointer)
 * because CALLING the real ones loads better-sqlite3 and crashes bun.
 *
 * Other test files (e.g. tests/stack-versioning.test.ts) use the pure SQL
 * builders (buildRead / buildUpdate / buildInsert) from this module. To keep
 * the whole-suite mock from breaking them, every function export dispatches to
 * a per-test registration WHEN PRESENT and otherwise falls through to the REAL
 * implementation (imported above, before the mock replaces the live exports).
 * Constant exports (the SQL strings) are passed through verbatim.
 *
 * Adding a new runtime accessor a test needs? Add its name to KNOWN_EXPORTS
 * below, then call `registerPointersFake(name, fn)` from your test file. Do
 * NOT add a separate mock.module('.../stack-source-pointers', ...) call
 * anywhere else in the suite.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

/** Every $lib/server/stack-source-pointers export any test file may need. */
const KNOWN_EXPORTS = [
	'READ_SQL',
	'UPDATE_SQL',
	'INSERT_SQL',
	'buildRead',
	'buildUpdate',
	'buildInsert',
	'readStackSourcePointer',
	'upsertStackSourcePointer'
] as const;

const impls: Record<string, AnyFn> = {};

export function registerPointersFake(name: (typeof KNOWN_EXPORTS)[number], fn: AnyFn): void {
	impls[name] = fn;
}

function dispatcher(name: string): AnyFn {
	return (...args: unknown[]) => {
		const impl = impls[name];
		if (impl) {
			return impl(...args);
		}
		// No test registered a fake for this export: run the REAL
		// implementation (import-safe at module level; only throws if the test
		// actually drives a db access that better-sqlite3 cannot load - the
		// same outcome as not mocking at all).
		const realExport = (real as unknown as Record<string, AnyFn>)[name];
		if (typeof realExport !== 'function') {
			throw new Error(`pointers-fake: '${name}' is not a function and no fake is registered`);
		}
		return realExport(...args);
	};
}

const moduleShape: Record<string, unknown> = {};
for (const name of KNOWN_EXPORTS) {
	const realExport = (real as unknown as Record<string, unknown>)[name];
	moduleShape[name] = typeof realExport === 'function' ? dispatcher(name) : realExport;
}

mock.module('$lib/server/stack-source-pointers', () => moduleShape);
