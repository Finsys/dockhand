import { describe, test, expect } from 'bun:test';
import { formatUnhandledRejection, installCrashGuard } from '../src/lib/server/crash-guard';

// The crash guard keeps Dockhand alive on an unhandled promise rejection and logs a full
// dump. formatUnhandledRejection is the pure part - it must never throw and must surface
// message, code, stack, and cause so the leak is traceable.
describe('crash guard formatting', () => {
	test('includes message and stack for an Error', () => {
		const err = new Error('boom');
		const lines = formatUnhandledRejection(err);
		expect(lines[0]).toContain('boom');
		expect(lines[0]).toContain('process kept alive');
		expect(lines.some((l) => l.includes('crash-guard.test'))).toBe(true); // the stack
	});

	test('includes an error code when present (e.g. undici body timeout)', () => {
		const err = Object.assign(new Error('Body Timeout Error'), { code: 'UND_ERR_BODY_TIMEOUT' });
		const lines = formatUnhandledRejection(err);
		expect(lines[0]).toContain('[UND_ERR_BODY_TIMEOUT]');
	});

	test('surfaces a cause when the rejection wraps one', () => {
		const cause = new Error('BodyTimeoutError');
		const err = new Error('terminated', { cause });
		const lines = formatUnhandledRejection(err);
		expect(lines.some((l) => l.includes('caused by') && l.includes('BodyTimeoutError'))).toBe(true);
	});

	test('handles a non-Error reason without throwing', () => {
		const lines = formatUnhandledRejection('just a string');
		expect(lines[0]).toContain('just a string');
	});

	test('stringifies a null/undefined reason into the output', () => {
		expect(() => formatUnhandledRejection(null)).not.toThrow();
		expect(formatUnhandledRejection(null)[0]).toContain('null');
		expect(formatUnhandledRejection(undefined)[0]).toContain('undefined');
	});
});

// The installed handler is the safety-critical part: it must log-and-return (never exit
// or rethrow) so a background rejection cannot crash the process, and installCrashGuard
// must be idempotent (import already installed one listener at module load).
describe('crash guard installation', () => {
	test('installCrashGuard is idempotent - a second call adds no listener', () => {
		const before = process.listenerCount('unhandledRejection');
		installCrashGuard();
		installCrashGuard();
		expect(process.listenerCount('unhandledRejection')).toBe(before);
	});

	test('the installed handler logs and does not throw or exit', () => {
		const listeners = process.listeners('unhandledRejection');
		expect(listeners.length).toBeGreaterThan(0);
		const handler = listeners[listeners.length - 1] as (reason: unknown) => void;

		const origError = console.error;
		const origExit = process.exit;
		let logged = 0;
		let exited = false;
		console.error = () => { logged++; };
		// @ts-expect-error - stub exit to catch an accidental process.exit
		process.exit = () => { exited = true; };
		try {
			expect(() => handler(Object.assign(new Error('boom'), { code: 'UND_ERR_BODY_TIMEOUT' }))).not.toThrow();
		} finally {
			console.error = origError;
			process.exit = origExit;
		}
		expect(logged).toBeGreaterThan(0);
		expect(exited).toBe(false);
	});
});
