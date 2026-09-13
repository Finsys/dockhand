/**
 * Unit tests for backups/operations-core.ts — the pure decision logic of the
 * operation record: terminal-status derivation, the startup scrub rule, and the
 * progress throttle.
 */
import { describe, it, expect } from 'bun:test';
import {
	deriveTerminalState,
	toExecutionStatus,
	shouldWriteProgress,
	isAlwaysPersistedStatus,
	ProgressThrottle,
	type Outcome,
} from '../../src/lib/server/backups/operations-core';

describe('deriveTerminalState — one place decides the terminal status', () => {
	it('ok → success', () => {
		expect(deriveTerminalState({ kind: 'ok' })).toEqual({ status: 'success' });
	});
	it('warning → warning with the message', () => {
		expect(deriveTerminalState({ kind: 'warning', message: 'partial read' }))
			.toEqual({ status: 'warning', message: 'partial read' });
	});
	it('cancelled → cancelled (default message)', () => {
		expect(deriveTerminalState({ kind: 'cancelled' })).toEqual({ status: 'cancelled', message: 'Cancelled' });
		expect(deriveTerminalState({ kind: 'cancelled', message: 'by user' }))
			.toEqual({ status: 'cancelled', message: 'by user' });
	});
	it('error → error with message + code', () => {
		const o: Outcome = { kind: 'error', code: 'INTEGRITY', message: 'snapshot unreadable' };
		expect(deriveTerminalState(o)).toEqual({ status: 'error', message: 'snapshot unreadable', errorCode: 'INTEGRITY' });
	});
});

describe('toExecutionStatus — engine vocab → shared executions-table vocab', () => {
	it('error → failed (the schedules UI reads "failed", not the engine-internal "error")', () => {
		expect(toExecutionStatus('error')).toBe('failed');
	});
	it('cancelled → failed (no "cancelled" in the executions vocab)', () => {
		expect(toExecutionStatus('cancelled')).toBe('failed');
	});
	it('success/warning pass through', () => {
		expect(toExecutionStatus('success')).toBe('success');
		expect(toExecutionStatus('warning')).toBe('warning');
	});
	it('a skipped-flagged close maps to skipped regardless of the terminal status', () => {
		expect(toExecutionStatus('error', { skipped: true })).toBe('skipped');
		expect(toExecutionStatus('success', { skipped: true })).toBe('skipped');
	});
});

describe('shouldWriteProgress — first write immediate, then throttled', () => {
	it('always writes the first update (lastWrittenAt null)', () => {
		expect(shouldWriteProgress(null, 1000, 1000)).toBe(true);
	});
	it('suppresses a write within the interval', () => {
		expect(shouldWriteProgress(1000, 1500, 1000)).toBe(false);
	});
	it('allows a write once the interval has elapsed', () => {
		expect(shouldWriteProgress(1000, 2000, 1000)).toBe(true);
		expect(shouldWriteProgress(1000, 2001, 1000)).toBe(true);
	});
});

describe('ProgressThrottle — stateful, clock injected', () => {
	it('writes first, throttles within interval, writes again after', () => {
		let t = 0;
		const th = new ProgressThrottle(1000, () => t);
		expect(th.shouldWrite()).toBe(true);   // t=0, first
		t = 500;
		expect(th.shouldWrite()).toBe(false);  // within 1000
		t = 1000;
		expect(th.shouldWrite()).toBe(true);   // interval elapsed
		t = 1200;
		expect(th.shouldWrite()).toBe(false);  // within next interval
	});
});

describe('isAlwaysPersistedStatus — only restic spam is throttled', () => {
	it("throttles ONLY the high-frequency restic stream (status 'progress')", () => {
		expect(isAlwaysPersistedStatus('progress')).toBe(false);
	});
	it('ALWAYS persists every meaningful low-frequency event', () => {
		// Stage markers, the volume list, lifecycle steps, errors/warnings must never
		// drop out of the execution log when they collide with restic spam.
		for (const s of ['metadata', 'backing-up', 'verifying', 'pruning', 'restoring',
			'recreating', 'redeploying', 'starting', 'stopping', 'restarted', 'error', 'warning']) {
			expect(isAlwaysPersistedStatus(s)).toBe(true);
		}
	});
});
