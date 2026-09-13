/**
 * Regression tests for per-stack branch selection (git_stacks.branch).
 *
 * The pure production helpers live in src/lib/git-stack-branch.ts (import-
 * light: no native deps like better-sqlite3 / argon2), so these tests import
 * and exercise the EXACT functions that production code uses:
 *   - resolveStackBranch   -> src/lib/server/git.ts (deploy/sync)
 *   - effectiveStackBranch -> src/routes/stacks/+page.svelte & GitSourceBadge
 *                            (the effective branch shown in the stacks UI)
 *   - normalizeStackBranchUpdate -> PUT /api/git/stacks/:id (+server.ts)
 * No mirrored copies of the implementation exist here — if the production
 * behaviour changes, these tests break.
 */

import { describe, expect, test } from 'bun:test';
import {
	resolveStackBranch,
	effectiveStackBranch,
	normalizeStackBranchUpdate
} from '../src/lib/git-stack-branch';

describe('resolveStackBranch (production: src/lib/server/git.ts)', () => {
	test('per-stack override wins over repository default', () => {
		expect(resolveStackBranch({ branch: 'develop' }, { branch: 'main' })).toBe(
			'develop'
		);
	});

	test('null override inherits the repository default', () => {
		expect(resolveStackBranch({ branch: null }, { branch: 'main' })).toBe('main');
	});

	test('blank override inherits the repository default', () => {
		expect(resolveStackBranch({ branch: '' }, { branch: 'main' })).toBe('main');
	});

	test('whitespace-only override is treated as blank → repository default', () => {
		expect(resolveStackBranch({ branch: '   ' }, { branch: 'main' })).toBe('main');
	});

	test('whitespace around a real override is trimmed consistently', () => {
		expect(resolveStackBranch({ branch: '  feature/x  ' }, { branch: 'main' })).toBe(
			'feature/x'
		);
	});

	test('repository default is used when no override exists (no stack / undefined)', () => {
		expect(resolveStackBranch(undefined, { branch: 'release/1.2' })).toBe('release/1.2');
	});

	test('accepts arbitrary branch strings (not validated as git refs)', () => {
		expect(resolveStackBranch({ branch: 'a/b-c_d' }, { branch: 'zzz' })).toBe('a/b-c_d');
	});
});

describe(
	'effectiveStackBranch (production UI: +page.svelte viewGitStack & GitSourceBadge)',
	() => {
		test('a per-stack override is shown and flagged as per-stack', () => {
			const r = effectiveStackBranch({ branch: 'develop' }, { branch: 'main' });
			expect(r.branch).toBe('develop');
			expect(r.perStack).toBe(true);
		});

		test('no override → repository default, perStack is null', () => {
			const r = effectiveStackBranch({ branch: null }, { branch: 'main' });
			expect(r.branch).toBe('main');
			expect(r.perStack).toBeNull();
		});

		test('blank / whitespace-only override is NOT a per-stack branch (falls back to repo default)', () => {
			// Consistent with resolveStackBranch: a blank stored override is not a
			// per-stack branch — it falls back to the repository default.
			const r = effectiveStackBranch({ branch: '  ' }, { branch: 'main' });
			expect(r.branch).toBe('main');
			expect(r.perStack).toBeNull();
		});

		test('no stack / no repo → undefined, perStack null', () => {
			const r = effectiveStackBranch(undefined, undefined);
			expect(r.branch).toBeUndefined();
			expect(r.perStack).toBeNull();
		});

		test('stack present but no repository → shows the override', () => {
			const r = effectiveStackBranch({ branch: 'hotfix' }, undefined);
			expect(r.branch).toBe('hotfix');
			expect(r.perStack).toBe(true);
		});
	});

describe('normalizeStackBranchUpdate (production: PUT /api/git/stacks/:id)', () => {
	test('branch key absent → current override left untouched (no change)', () => {
		const r = normalizeStackBranchUpdate('develop', { stackName: 'x' });
		expect(r.next).toBe('develop');
		expect(r.changed).toBe(false);
	});

	test('explicit null clears the override (inherit repository default)', () => {
		const r = normalizeStackBranchUpdate('develop', { branch: null });
		expect(r.next).toBeNull();
		expect(r.changed).toBe(true);
	});

	test('null on a stack that already inherits is still an applied write', () => {
		const r = normalizeStackBranchUpdate(null, { branch: null });
		expect(r.next).toBeNull();
		expect(r.changed).toBe(true);
	});

	test('non-blank string sets the per-stack override', () => {
		const r = normalizeStackBranchUpdate(null, { branch: 'hotfix/42' });
		expect(r.next).toBe('hotfix/42');
		expect(r.changed).toBe(true);
	});

	test('surrounding whitespace is trimmed on a non-blank value', () => {
		const r = normalizeStackBranchUpdate(null, { branch: '  hotfix/42  ' });
		expect(r.next).toBe('hotfix/42');
		expect(r.changed).toBe(true);
	});

	test('blank / whitespace-only branch is normalised to clear (inherit default)', () => {
		const r = normalizeStackBranchUpdate('develop', { branch: '   ' });
		expect(r.next).toBeNull();
		expect(r.changed).toBe(true);
	});

	test('co-located fields (stackName etc.) do not touch the branch', () => {
		const r = normalizeStackBranchUpdate(null, { composePath: 'docker-compose.prod.yml' });
		expect(r.next).toBeNull();
		expect(r.changed).toBe(false);
	});
});
