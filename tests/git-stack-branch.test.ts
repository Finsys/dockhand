/**
 * Unit tests for per-stack branch resolution (git_stacks.branch).
 *
 * `resolveStackBranch` in src/lib/server/git.ts is a pure resolver:
 *   per-stack override wins when non-blank, else fall back to repo.branch.
 * Importing git.ts pulls native deps (better-sqlite3/argon2), so — matching
 * the convention in tests/git-branches.test.ts — we mirror the exact
 * implementation here and test that, plus the API partial-update semantics
 * for the branch field on PUT /api/git/stacks/:id.
 */

import { describe, expect, test } from 'bun:test';

/** Mirror of resolveStackBranch (src/lib/server/git.ts). Keep in sync. */
function resolveStackBranch(
	gitStack: { branch: string | null } | null | undefined,
	repository: { branch: string }
): string {
	const override = gitStack?.branch?.trim();
	return override || repository.branch;
}

/**
 * Mirror of the PUT /api/git/stacks/:id partial-update semantics for branch:
 * only apply when the key is present in the body; explicit null clears the
 * override back to "inherit repo default"; blank strings are also treated as
 * clear-on-save (trimmed away by the resolver anyway).
 */
function applyBranchUpdate(
	current: string | null,
	body: Record<string, unknown>
): { next: string | null; changed: boolean } {
	if (!('branch' in body)) return { next: current, changed: false };
	const value = body.branch;
	return { next: value === null ? null : (value as string), changed: true };
}

describe('resolveStackBranch', () => {
	test('per-stack override wins over repo default', () => {
		expect(
			resolveStackBranch({ branch: 'develop' }, { branch: 'main' })
		).toBe('develop');
	});

	test('null stack branch falls back to repo default', () => {
		expect(
			resolveStackBranch({ branch: null }, { branch: 'main' })
		).toBe('main');
	});

	test('missing gitStack (undefined) falls back to repo default', () => {
		expect(resolveStackBranch(undefined, { branch: 'release/1.2' })).toBe(
			'release/1.2'
		);
	});

	test('whitespace-only override is treated as blank → repo default', () => {
		expect(
			resolveStackBranch({ branch: '   ' }, { branch: 'main' })
		).toBe('main');
	});

	test('surrounding whitespace on a real override is trimmed', () => {
		expect(
			resolveStackBranch({ branch: '  feature/x  ' }, { branch: 'main' })
		).toBe('feature/x');
	});

	test('empty-string override falls back to repo default', () => {
		expect(resolveStackBranch({ branch: '' }, { branch: 'main' })).toBe(
			'main'
		);
	});

	test('works with branch names that are not git refs either (arbitrary strings)', () => {
		expect(
			resolveStackBranch({ branch: 'a/b-c_d' }, { branch: 'zzz' })
		).toBe('a/b-c_d');
	});
});

describe('PUT /api/git/stacks/:id partial branch semantics', () => {
	test('branch key absent → stored value untouched', () => {
		const r = applyBranchUpdate('develop', { stackName: 'x' });
		expect(r.next).toBe('develop');
		expect(r.changed).toBe(false);
	});

	test('explicit null clears the override (inherit repo default)', () => {
		const r = applyBranchUpdate('develop', { branch: null });
		expect(r.next).toBeNull();
		expect(r.changed).toBe(true);
	});

	test('null on a stack that already inherits is a no-op value-wise but still an applied write', () => {
		const r = applyBranchUpdate(null, { branch: null });
		expect(r.next).toBeNull();
		expect(r.changed).toBe(true);
	});

	test('string sets the per-stack override', () => {
		const r = applyBranchUpdate(null, { branch: 'hotfix/42' });
		expect(r.next).toBe('hotfix/42');
		expect(r.changed).toBe(true);
	});

	test('co-located fields (stackName etc.) do not touch branch', () => {
		const r = applyBranchUpdate(null, { composePath: 'docker-compose.prod.yml' });
		expect(r.next).toBeNull();
		expect(r.changed).toBe(false);
	});
});

describe('effective-branch UI semantics (viewGitStack / badge)', () => {
	/** Mirror of +page.svelte viewGitStack effective branch computation. */
	function effectiveBranchDisplay(
		gitStack: { branch: string | null } | null | undefined,
		repository: { branch: string } | null | undefined
	): { branch: string | undefined; perStack: boolean | null } {
		const perStackBranch = gitStack?.branch ?? null;
		return {
			branch: perStackBranch || (repository?.branch || undefined),
			perStack: perStackBranch ? true : null
		};
	}

	test('override shows per-stack branch, flagged as per-stack', () => {
		const r = effectiveBranchDisplay(
			{ branch: 'develop' },
			{ branch: 'main' }
		);
		expect(r.branch).toBe('develop');
		expect(r.perStack).toBe(true);
	});

	test('no override → repo default, perStack null', () => {
		const r = effectiveBranchDisplay(
			{ branch: null },
			{ branch: 'main' }
		);
		expect(r.branch).toBe('main');
		expect(r.perStack).toBeNull();
	});

	test('no stack, no repo → undefined', () => {
		const r = effectiveBranchDisplay(undefined, undefined);
		expect(r.branch).toBeUndefined();
		expect(r.perStack).toBeNull();
	});
});
