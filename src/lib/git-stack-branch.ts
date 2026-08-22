/**
 * Pure branch-selection helpers for git stacks.
 *
 * These functions are dependency-free and safe to import from the browser and
 * from unit tests without pulling in native/server initialisation
 * (better-sqlite3 / argon2, etc). Both the production code (sync/deploy in
 * src/lib/server/git.ts, the stacks routes) and the stacks UI import them, so
 * a single implementation is the source of truth for "which branch does this
 * stack deploy from" — the tests in tests/git-stack-branch.test.ts exercise
 * these exact functions rather than a mirrored copy.
 */

/**
 * The effective branch a git stack deploys from.
 *
 * A per-stack branch override (git_stacks.branch) wins; when it is unset,
 * null, empty, or whitespace-only, the repository's default branch is used.
 */
export function resolveStackBranch(
	gitStack: { branch: string | null } | null | undefined,
	repository: { branch: string }
): string {
	const override = gitStack?.branch?.trim();
	return override || repository.branch;
}

/**
 * Effective branch for display in the stacks UI (list badge / stack modal
 * header). Follows the same rule as resolveStackBranch, but tolerates a
 * missing repository and reports whether the shown branch is a per-stack
 * override:
 *
 *   - branch: the per-stack override when set (non-blank), else the
 *     repository default (or undefined when neither is available).
 *   - perStack: true when the shown branch is a per-stack override (a
 *     non-blank stored value), else null (shown branch is the repository
 *     default / nothing set).
 *
 * Consistency: a blank (empty / whitespace-only) override is NOT treated as a
 * per-stack branch — it falls back to the repository default, exactly as
 * resolveStackBranch does for deploy/sync. Only a non-blank stored override is
 * shown as a per-stack branch.
 */
export function effectiveStackBranch(
	gitStack: { branch?: string | null } | null | undefined,
	repository: { branch?: string } | null | undefined
): { branch: string | undefined; perStack: boolean | null } {
	const raw = gitStack?.branch ?? null;
	const perStackBranch = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
	return {
		branch: perStackBranch || (repository?.branch || undefined),
		perStack: perStackBranch ? true : null
	};
}

/**
 * Normalise the `branch` field of the PUT /api/git/stacks/:id partial update
 * into a next stored value.
 *
 * Semantics (the API contract the stacks route implements):
 *   - key ABSENT in the body  -> leave the current override untouched
 *     ({ next: current, changed: false });
 *   - explicit `null`         -> clear the override so the stack inherits the
 *     repository default ({ next: null, changed: true });
 *   - non-blank string        -> set the per-stack override, stored
 *     whitespace-trimmed ({ next: <trimmed>, changed: true });
 *   - blank / whitespace-only -> clear the override, normalised to null so a
 *     blank save is treated as "inherit repository default" consistently
 *     ({ next: null, changed: true }).
 */
export function normalizeStackBranchUpdate(
	current: string | null,
	body: Record<string, unknown>
): { next: string | null; changed: boolean } {
	if (!('branch' in body)) return { next: current, changed: false };
	const value = body.branch;
	if (value === null) return { next: null, changed: true };
	const trimmed = typeof value === 'string' ? value.trim() : '';
	return { next: trimmed || null, changed: true };
}
