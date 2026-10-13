import { describe, test, expect } from 'bun:test';
import { canSkipTreeRehash } from '../src/lib/server/git-deletions';

const A = 'aaaaaaa1111111111111111111111111111111111';
const A7 = 'aaaaaaa'; // same 7-char prefix, DB-stored short form
const B = 'bbbbbbb2222222222222222222222222222222222';

describe('canSkipTreeRehash', () => {
	test('skips when no change, prior manifest, and baselines match (full vs full)', () => {
		expect(canSkipTreeRehash(false, 5, A, A)).toBe(true);
	});

	test('skips when baselines match by 7-char prefix (manifest full vs DB short)', () => {
		expect(canSkipTreeRehash(false, 5, A, A7)).toBe(true);
	});

	test('does NOT skip when the diff baseline drifted from the manifest commit', () => {
		// bare Sync advanced lastCommit to B while manifest stayed at A -> must re-hash
		expect(canSkipTreeRehash(false, 5, A, B)).toBe(false);
	});

	test('does NOT skip when files changed', () => {
		expect(canSkipTreeRehash(true, 5, A, A)).toBe(false);
	});

	test('does NOT skip on the first sync (empty manifest must be built)', () => {
		expect(canSkipTreeRehash(false, 0, A, A)).toBe(false);
	});

	test('does NOT skip when change state is unknown (new clone / diff failed)', () => {
		expect(canSkipTreeRehash(undefined, 5, A, A)).toBe(false);
	});

	test('does NOT skip when either commit is null/empty', () => {
		expect(canSkipTreeRehash(false, 5, null, A)).toBe(false);
		expect(canSkipTreeRehash(false, 5, A, null)).toBe(false);
		expect(canSkipTreeRehash(false, 5, A, '')).toBe(false);
	});
});
