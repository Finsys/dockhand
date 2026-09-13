/**
 * Unit tests for parseResticDiff — turns `restic diff --json` (and the plain-text
 * fallback) into the {added, removed, modified, metadataChanged} shape the diff
 * modal renders. A regression here shows up as the compare dialog spinning forever
 * (the client reads diff.added.length on an unparsed {raw} blob).
 */
import { describe, it, expect } from 'bun:test';
import { parseResticDiff } from '../../src/lib/server/backups/helpers';

describe('parseResticDiff — restic --json change lines', () => {
	it('buckets +/-/M and metadata-only (U/T) modifiers', () => {
		const raw = [
			JSON.stringify({ message_type: 'change', path: '/volumes/data/new.txt', modifier: '+' }),
			JSON.stringify({ message_type: 'change', path: '/volumes/data/gone.txt', modifier: '-' }),
			JSON.stringify({ message_type: 'change', path: '/volumes/data/edited.txt', modifier: 'M' }),
			JSON.stringify({ message_type: 'change', path: '/volumes/data/perms.txt', modifier: 'U' }),
			JSON.stringify({ message_type: 'statistics', changed_files: 3 }), // must be ignored
		].join('\n');
		const d = parseResticDiff(raw);
		expect(d.added).toEqual(['/volumes/data/new.txt']);
		expect(d.removed).toEqual(['/volumes/data/gone.txt']);
		expect(d.modified).toEqual(['/volumes/data/edited.txt']);
		expect(d.metadataChanged).toEqual(['/volumes/data/perms.txt']);
	});

	it('ignores blank lines and non-change JSON', () => {
		const raw = '\n' + JSON.stringify({ message_type: 'statistics' }) + '\n\n';
		const d = parseResticDiff(raw);
		expect(d.added).toHaveLength(0);
		expect(d.removed).toHaveLength(0);
		expect(d.modified).toHaveLength(0);
		expect(d.metadataChanged).toHaveLength(0);
	});

	it('falls back to plain-text restic diff ("<modifier>    <path>")', () => {
		const raw = ['+    /a', '-    /b', 'M    /c', 'T    /d'].join('\n');
		const d = parseResticDiff(raw);
		expect(d.added).toEqual(['/a']);
		expect(d.removed).toEqual(['/b']);
		expect(d.modified).toEqual(['/c']);
		expect(d.metadataChanged).toEqual(['/d']);
	});

	it('empty diff → all empty arrays (identical snapshots)', () => {
		const d = parseResticDiff('');
		expect(d).toEqual({ added: [], removed: [], modified: [], metadataChanged: [] });
	});
});
