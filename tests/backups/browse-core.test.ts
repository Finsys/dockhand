/**
 * Unit tests for backups/browse-core.ts — parsing `restic ls --json` output into
 * a directory's child nodes. No docker, no DB.
 *
 * Regression: `restic ls --json <dir>` emits a node for the queried dir ITSELF in
 * addition to its children. If it isn't dropped, the snapshot browser shows a
 * phantom empty child named after the directory (an empty `volumes/` inside
 * `/volumes/`, `bt-container-vol/` inside `/volumes/bt-container-vol/`, etc.).
 */
import { describe, it, expect } from 'bun:test';
import { parseSnapshotLsEntries } from '../../src/lib/server/backups/browse-core';

// One JSON object per line, exactly as `restic ls --json` emits: a snapshot
// header line, the self-node for the queried dir, then the children.
function lines(...objs: any[]): string {
	return objs.map((o) => JSON.stringify(o)).join('\n');
}

const header = { struct_type: 'snapshot', id: 'abc', paths: ['/volumes'] };
const node = (path: string, name: string, type = 'dir') => ({
	struct_type: 'node', path, name, type,
});

describe('parseSnapshotLsEntries', () => {
	it('drops the self-node for the queried directory (the ghost)', () => {
		// This is the exact shape seen live: `restic ls --json <snap> /volumes`.
		const stdout = lines(
			header,
			node('/volumes', 'volumes'), // <- self, must be dropped
			node('/volumes/bt-container-vol', 'bt-container-vol'),
			node('/volumes/data_bind', 'data_bind'),
		);
		const names = parseSnapshotLsEntries(stdout, '/volumes').map((e) => e.name);
		expect(names).toEqual(['bt-container-vol', 'data_bind']);
		expect(names).not.toContain('volumes');
	});

	it('drops the self-node one level deep too', () => {
		const stdout = lines(
			header,
			node('/volumes/bt-container-vol', 'bt-container-vol'), // <- self
			node('/volumes/bt-container-vol/container-vol.txt', 'container-vol.txt', 'file'),
		);
		const names = parseSnapshotLsEntries(stdout, '/volumes/bt-container-vol').map((e) => e.name);
		expect(names).toEqual(['container-vol.txt']);
	});

	it('keeps real top-level children when browsing root', () => {
		const stdout = lines(
			header,
			node('/', ''), // <- self root
			node('/metadata', 'metadata'),
			node('/volumes', 'volumes'),
		);
		const names = parseSnapshotLsEntries(stdout, '/').map((e) => e.name);
		expect(names).toEqual(['metadata', 'volumes']);
	});

	it('handles a trailing slash on the queried path', () => {
		const stdout = lines(
			header,
			node('/volumes', 'volumes'),
			node('/volumes/x', 'x'),
		);
		const names = parseSnapshotLsEntries(stdout, '/volumes/').map((e) => e.name);
		expect(names).toEqual(['x']);
	});

	it('ignores snapshot header and non-node lines', () => {
		const stdout = lines(
			header,
			{ struct_type: 'other', foo: 1 },
			node('/volumes/keep', 'keep'),
		);
		const names = parseSnapshotLsEntries(stdout, '/volumes').map((e) => e.name);
		expect(names).toEqual(['keep']);
	});

	it('tolerates blank and malformed lines', () => {
		const stdout = [
			'',
			'not json',
			JSON.stringify(node('/volumes', 'volumes')),
			'   ',
			JSON.stringify(node('/volumes/ok', 'ok')),
		].join('\n');
		const names = parseSnapshotLsEntries(stdout, '/volumes').map((e) => e.name);
		expect(names).toEqual(['ok']);
	});

	it('accepts message_type nodes (current restic) as well as struct_type (deprecated)', () => {
		// restic deprecated struct_type in favor of message_type. A restic bump that drops
		// struct_type must NOT empty the browser - both discriminators must be recognized.
		const mtNode = (path: string, name: string) => ({ message_type: 'node', path, name, type: 'dir' });
		const stdout = lines(
			{ message_type: 'snapshot', id: 'abc' },
			mtNode('/volumes', 'volumes'),          // self, dropped
			mtNode('/volumes/child', 'child'),
		);
		const names = parseSnapshotLsEntries(stdout, '/volumes').map((e) => e.name);
		expect(names).toEqual(['child']);
	});
});
