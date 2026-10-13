import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolveContainer, labelForMissing } from '../src/lib/utils/stale-container-id';

const running = [
	{ id: '35b3ac2af721', name: 'qbittorrent' },
	{ id: 'aaaa1111', name: 'metabase' }
];

describe('finding a container behind a stale id', () => {
	test('a live id is used as it is', () => {
		expect(resolveContainer(running, 'aaaa1111', 'metabase')?.name).toBe('metabase');
	});

	// The reported case: a scheduled update recreated it hours earlier, so the id in
	// the selection is the one it had BEFORE.
	test('a recreated container is found by the name the pending row kept', () => {
		const found = resolveContainer(running, 'f62b7de8b08e', 'qbittorrent');
		expect(found?.id).toBe('35b3ac2af721');
	});

	test('a container that is really gone stays gone', () => {
		expect(resolveContainer(running, 'f62b7de8b08e', 'deleted-thing')).toBeNull();
	});

	test('without a recorded name there is nothing to fall back on', () => {
		expect(resolveContainer(running, 'f62b7de8b08e', null)).toBeNull();
		expect(resolveContainer(running, 'f62b7de8b08e', '')).toBeNull();
	});

	// The id is authoritative: a name collision must not redirect a live container.
	test('the id wins when both could match', () => {
		const twins = [
			{ id: 'aaaa1111', name: 'shared' },
			{ id: 'bbbb2222', name: 'shared' }
		];
		expect(resolveContainer(twins, 'bbbb2222', 'shared')?.id).toBe('bbbb2222');
	});

	test('an empty list finds nothing rather than throwing', () => {
		expect(resolveContainer([], 'anything', 'name')).toBeNull();
	});
});

describe('what a missing container is called', () => {
	test('the recorded name beats "unknown"', () => {
		expect(labelForMissing('qbittorrent')).toBe('qbittorrent');
	});

	test('nothing recorded falls back to unknown', () => {
		expect(labelForMissing(null)).toBe('unknown');
		expect(labelForMissing('   ')).toBe('unknown');
	});
});

describe('what the caller must do with the result', () => {
	// The trap this file was written to guard and did not: the helper can return a
	// DIFFERENT container than the id asked for, so every later daemon call has to use
	// the resolved id. Using the one that was submitted inspects a container that no
	// longer exists, and the recovery fails at the first step.
	const endpoint = readFileSync(
		new URL('../src/routes/api/containers/batch-update-stream/+server.ts', import.meta.url),
		'utf8'
	);

	test('the batch endpoint inspects the resolved container, not the submitted id', () => {
		expect(endpoint).toContain('inspectContainer(liveId');
		expect(endpoint).not.toContain('inspectContainer(containerId');
	});

	test('it starts tracking from the resolved id too', () => {
		expect(endpoint).toContain('let newContainerId = liveId');
	});

	// A row written against an id the container no longer has is exactly what #1632 is
	// about, so clearing it by that id would leave the same stale row behind.
	test('it clears the pending row by name, which survives a recreate', () => {
		expect(endpoint).toContain('removePendingContainerUpdateByName(envIdNum, containerName)');
	});
});
