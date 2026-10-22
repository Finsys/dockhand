/**
 * One logs panel is rendered, so the remembered session and the lit row icon must both
 * follow it. Behaviour, not source text - a reformat must not fail these.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	nextLogsSessions,
	panelsAfterRowClick,
	showsLogsIndicator
} from '../src/lib/utils/active-logs-core';

const a = { containerId: 'a', containerName: 'ca' };
const b = { containerId: 'b', containerName: 'cb' };

describe('nextLogsSessions', () => {
	it('keeps one session, replacing whatever was there', () => {
		expect(nextLogsSessions([], { id: 'a', name: 'ca' })).toEqual([a]);
		expect(nextLogsSessions([a], { id: 'b', name: 'cb' })).toEqual([b]);
	});

	it('never grows, however many times logs are opened', () => {
		let s = nextLogsSessions([], { id: 'a', name: 'ca' });
		s = nextLogsSessions(s, { id: 'b', name: 'cb' });
		s = nextLogsSessions(s, { id: 'c', name: 'cc' });
		expect(s.length).toBe(1);
		expect(s[0].containerId).toBe('c');
	});

	it('does not mutate the list it was given', () => {
		const before = [a];
		nextLogsSessions(before, { id: 'b', name: 'cb' });
		expect(before).toEqual([a]);
	});
});

describe('panelsAfterRowClick', () => {
	const noTerminals = () => false;

	it('hides the logs panel when its own container row is clicked', () => {
		expect(panelsAfterRowClick({ logsId: 'a', terminalId: null }, 'a', noTerminals).logsId).toBe(null);
	});

	// A row click must never touch a panel belonging to a different container.
	it('leaves another container logs panel alone', () => {
		expect(panelsAfterRowClick({ logsId: 'a', terminalId: null }, 'b', noTerminals).logsId).toBe('a');
	});

	it('stays closed when no logs are open', () => {
		expect(panelsAfterRowClick({ logsId: null, terminalId: null }, 'a', noTerminals).logsId).toBe(null);
	});

	// Terminals keep every session mounted, so a row click switches between them.
	it('switches to a container that has a terminal', () => {
		const has = (id: string) => id === 'b';
		expect(panelsAfterRowClick({ logsId: null, terminalId: 'a' }, 'b', has).terminalId).toBe('b');
	});

	it('hides the terminal for a container that has none', () => {
		expect(panelsAfterRowClick({ logsId: null, terminalId: 'a' }, 'b', noTerminals).terminalId).toBe(null);
	});

	it('decides both panels in one go', () => {
		const has = (id: string) => id === 'b';
		expect(panelsAfterRowClick({ logsId: 'a', terminalId: 'a' }, 'b', has)).toEqual({
			logsId: 'a',
			terminalId: 'b'
		});
	});
});

// The helpers only protect anything if the page actually calls them. Asserted at
// source level because +page.svelte cannot be imported into bun.
describe('containers page wiring', () => {
	const page = readFileSync(
		new URL('../src/routes/containers/+page.svelte', import.meta.url),
		'utf-8'
	);

	it('decides a row click through panelsAfterRowClick', () => {
		expect(page).toContain('panelsAfterRowClick(');
		expect(page).not.toMatch(/if \(hasActiveTerminal\(container\.id\)\) \{/);
	});

	it('lights the row icon from the visible panel, not the session list', () => {
		expect(page).toContain('showsLogsIndicator(currentLogsContainerId, containerId)');
		expect(page).not.toMatch(/activeLogs\.some\(/);
	});

	it('replaces the logs session rather than appending', () => {
		expect(page).toContain('nextLogsSessions(activeLogs, container)');
		expect(page).not.toMatch(/activeLogs = \[\s*\.\.\.activeLogs/);
	});

	it('renders one logs panel and every terminal', () => {
		expect(page).not.toMatch(/\{#each\s+activeLogs/);
		expect(page).toMatch(/\{#each\s+activeTerminals/);
	});
});

describe('showsLogsIndicator', () => {
	it('lights only the container whose panel is visible', () => {
		expect(showsLogsIndicator('a', 'a')).toBe(true);
		expect(showsLogsIndicator('a', 'b')).toBe(false);
		expect(showsLogsIndicator(null, 'a')).toBe(false);
	});
});
