import { mock } from 'bun:test';

/**
 * Shared registration point for faking `$lib/server/stacks`.
 *
 * Mirrors tests/helpers/db-fake.ts exactly, for the same two reasons documented
 * there: mock.module() replaces a module's exports WHOLESALE for the entire test
 * process, and once ANY file resolves the '$lib/server/stacks' specifier its export
 * set is frozen for the rest of the run. A second direct `mock.module('$lib/server/
 * stacks', ...)` call anywhere in the suite collides with whichever one resolved
 * first -- exactly the situation this file exists to avoid (see
 * tests/stack-compose-redeploy-run-record.test.ts's doc comment, which predicted this
 * exact need before a second file existed).
 *
 * Adding a new $lib/server/stacks export a test needs? Add its name to
 * KNOWN_EXPORTS below, then call `registerStacksFake('yourExportName', fn)` from your
 * test file. Do NOT add a separate mock.module('$lib/server/stacks', ...) call
 * anywhere else in the suite.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

/** Every $lib/server/stacks export any test file fakes, across the whole suite. */
const KNOWN_EXPORTS = [
	'getStackComposeFile',
	'saveStackComposeFile',
	'requireComposeFile',
	'deployStack',
	'getStackDir'
] as const;

const impls: Record<string, AnyFn> = {};

export function registerStacksFake(name: (typeof KNOWN_EXPORTS)[number], fn: AnyFn): void {
	impls[name] = fn;
}

function dispatcher(name: string): AnyFn {
	return (...args: unknown[]) => {
		const impl = impls[name];
		if (!impl) {
			throw new Error(
				`stacks-fake: '${name}' was called but no test file has registered an implementation for it yet ` +
					`(registerStacksFake('${name}', ...) must run before the test that calls it)`
			);
		}
		return impl(...args);
	};
}

const moduleShape: Record<string, AnyFn> = {};
for (const name of KNOWN_EXPORTS) {
	moduleShape[name] = dispatcher(name);
}

mock.module('$lib/server/stacks', () => moduleShape);
