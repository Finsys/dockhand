import { mock } from 'bun:test';

/**
 * Shared registration point for faking `$lib/server/authorize`.
 *
 * Same collision problem tests/helpers/db-fake.ts documents for $lib/server/db:
 * mock.module() replaces a module's exports WHOLESALE for the entire test process,
 * and Bun freezes the exported shape the first time ANY file resolves the specifier
 * -- so a second, independent `mock.module('$lib/server/authorize', ...)` call
 * elsewhere in the suite would silently clobber (or be clobbered by) this one,
 * depending on which file's import happens to run first.
 *
 * `authorize` is the module's only export, so a single dispatcher is enough: it
 * looks up `impl` AT CALL TIME (not at import time), so registerAuthorizeFake()
 * works no matter which test file calls it, or when, exactly like db-fake.ts's
 * per-name dispatchers.
 *
 * Do NOT add a separate mock.module('$lib/server/authorize', ...) or
 * mock.module('.../authorize', ...) call anywhere else in the suite -- that
 * reintroduces the collision this file exists to avoid.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

let impl: AnyFn | undefined;

export function registerAuthorizeFake(fn: AnyFn): void {
	impl = fn;
}

mock.module('$lib/server/authorize', () => ({
	authorize: (...args: unknown[]) => {
		if (!impl) {
			throw new Error(
				'authorize-fake: authorize() was called but no test file has registered an implementation yet ' +
					'(registerAuthorizeFake(fn) must run before the test that calls it)'
			);
		}
		return impl(...args);
	}
}));
