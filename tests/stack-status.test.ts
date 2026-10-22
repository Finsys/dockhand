/**
 * deriveStackStatus: a container in a restart loop is 'restarting', never 'stopped',
 * so the stack view offers Stop instead of Start (#1438).
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deriveStackStatus, deriveStackHealth } from '../src/lib/server/stack-status';

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

describe('deriveStackHealth', () => {
	const up = (health?: string) => ({ state: 'running', health });

	it('reports none when no container declares a healthcheck', () => {
		expect(deriveStackHealth([up(), up()])).toBe('none');
	});

	it('reports healthy when every checked container is healthy', () => {
		expect(deriveStackHealth([up('healthy'), up('healthy')])).toBe('healthy');
	});

	// The whole point: this stack's status is still 'running'.
	it('reports unhealthy when any container is unhealthy', () => {
		expect(deriveStackHealth([up('healthy'), up('unhealthy')])).toBe('unhealthy');
	});

	it('prefers unhealthy over starting', () => {
		expect(deriveStackHealth([up('starting'), up('unhealthy')])).toBe('unhealthy');
	});

	it('reports starting while a check has not settled', () => {
		expect(deriveStackHealth([up('healthy'), up('starting')])).toBe('starting');
	});

	it('ignores a container that is not up', () => {
		expect(deriveStackHealth([{ state: 'exited', health: 'unhealthy' }, up('healthy')])).toBe('healthy');
	});

	// Docker keeps the last health report across a pause, and the container is still
	// there, so hiding it would report a sick stack as healthy.
	it('counts a paused container', () => {
		expect(deriveStackHealth([{ state: 'paused', health: 'unhealthy' }, up('healthy')])).toBe('unhealthy');
		expect(deriveStackHealth([{ state: 'paused', health: 'healthy' }])).toBe('healthy');
	});

	it('counts a restarting container, which is trying to come up', () => {
		expect(deriveStackHealth([{ state: 'restarting', health: 'unhealthy' }])).toBe('unhealthy');
	});

	it('reports none for an empty stack', () => {
		expect(deriveStackHealth([])).toBe('none');
	});
});

// The derivation is only worth anything if listComposeStacks actually calls it.
// Asserted at source level because stacks.ts pulls in better-sqlite3, which bun
// cannot load (same approach as tests/env-file-values.test.ts).
describe('stack health wiring', () => {
	const source = readFileSync(
		new URL('../src/lib/server/stacks.ts', import.meta.url),
		'utf-8'
	);

	it('listComposeStacks reports health alongside status', () => {
		expect(source).toContain('health: deriveStackHealth(');
		expect(source).toMatch(/import \{[^}]*deriveStackHealth[^}]*\} from '\.\/stack-status'/);
	});

	it('reports health from the stack containers, not a hard-coded value', () => {
		expect(source).toContain('health: deriveStackHealth(containerDetails)');
	});
});
