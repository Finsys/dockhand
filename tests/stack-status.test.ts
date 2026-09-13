/**
 * deriveStackStatus: a container in a restart loop is 'restarting', never 'stopped',
 * so the stack view offers Stop instead of Start (#1438).
 */
import { describe, it, expect } from 'bun:test';
import { deriveStackStatus } from '../src/lib/server/stack-status';

describe('deriveStackStatus', () => {
	it('#1438: a single container in a restart loop is "restarting", not "stopped"', () => {
		expect(deriveStackStatus({ total: 1, running: 0, restarting: 1, completed: 0 })).toBe('restarting');
	});

	it('all containers running -> running', () => {
		expect(deriveStackStatus({ total: 3, running: 3, restarting: 0, completed: 0 })).toBe('running');
	});

	it('no active containers -> stopped', () => {
		expect(deriveStackStatus({ total: 2, running: 0, restarting: 0, completed: 0 })).toBe('stopped');
	});

	it('some running, some not -> partial', () => {
		expect(deriveStackStatus({ total: 3, running: 1, restarting: 0, completed: 0 })).toBe('partial');
	});

	it('some running AND some restarting -> partial (mixed, but live)', () => {
		expect(deriveStackStatus({ total: 3, running: 1, restarting: 1, completed: 0 })).toBe('partial');
	});

	it('all live containers restarting, none up -> restarting', () => {
		expect(deriveStackStatus({ total: 2, running: 0, restarting: 2, completed: 0 })).toBe('restarting');
	});

	it('completed (exit 0) init containers do not count against health', () => {
		// 1 completed init + 1 running app -> running (activeTotal = 1, running = 1)
		expect(deriveStackStatus({ total: 2, running: 1, restarting: 0, completed: 1 })).toBe('running');
	});

	it('a stack that is only a completed init container -> stopped', () => {
		expect(deriveStackStatus({ total: 1, running: 0, restarting: 0, completed: 1 })).toBe('stopped');
	});

	it('completed init + a restarting app -> restarting (Stop must be offered)', () => {
		expect(deriveStackStatus({ total: 2, running: 0, restarting: 1, completed: 1 })).toBe('restarting');
	});
});
