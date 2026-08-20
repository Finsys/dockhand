/**
 * Unit tests for shipped-file hashing and deletion planning used by git sync
 * and adopted/internal Hawser directory sync.
 */

// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { test, expect, describe } from 'bun:test';
import { computeDeletions, hashContent, hashShippedFiles } from '../src/lib/server/git-deletions';

describe('hashShippedFiles', () => {
	test('text entries hash to the same value as hashContent of the UTF-8 bytes the agent writes', () => {
		const text = 'FOO=bar\n# comment\n';
		const hashed = hashShippedFiles({ '.env': text });
		expect(hashed['.env']).toBe(hashContent(text));
		expect(hashed['.env']).toBe(hashContent(Buffer.from(text, 'utf8')));
	});

	test('base64: entries hash the decoded bytes, not the prefixed string', () => {
		const bytes = Buffer.from([0x00, 0x89, 0xff, 0x0a]);
		const payload = `base64:${bytes.toString('base64')}`;
		const hashed = hashShippedFiles({ 'bin/data.dat': payload });
		expect(hashed['bin/data.dat']).toBe(hashContent(bytes));
		expect(hashed['bin/data.dat']).not.toBe(hashContent(payload));
	});
});

describe('computeDeletions with a shipped-file manifest', () => {
	test('files absent from the new payload are deletion candidates; still-present files are not', () => {
		const prev = hashShippedFiles({
			'compose.yaml': 'services: {}\n',
			'config.yaml': 'keep: false\n',
			'scripts/run.sh': '#!/bin/sh\n'
		});
		const next = hashShippedFiles({
			'compose.yaml': 'services: {}\n',
			'.env': 'A=1\n'
		});
		const plan = computeDeletions(prev, next);
		expect(plan.toDelete.map((f) => f.path).sort()).toEqual(['config.yaml', 'scripts/run.sh']);
		expect(plan.toDelete.find((f) => f.path === 'config.yaml')?.hash).toBe(prev['config.yaml']);
		expect(plan.toDelete.some((f) => f.path === 'compose.yaml')).toBe(false);
	});

	test('compose and .env are load-bearing and never queued for deletion', () => {
		const prev = hashShippedFiles({
			'compose.yaml': 'old\n',
			'.env': 'OLD=1\n',
			'extra.conf': 'x\n'
		});
		const next = hashShippedFiles({ 'other.yaml': 'y\n' });
		const plan = computeDeletions(prev, next);
		expect(plan.toDelete.map((f) => f.path)).toEqual(['extra.conf']);
		expect(plan.skipped.map((s) => s.path).sort()).toEqual(['.env', 'compose.yaml']);
		expect(plan.skipped.every((s) => s.reason === 'load-bearing')).toBe(true);
	});
});
