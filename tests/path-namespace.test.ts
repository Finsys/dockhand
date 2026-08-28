import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getRepoPath, getGitReposDir, sanitizeRepoName, stackRepoPath, GIT_REPOS_DIR } from '../src/lib/server/git-paths';

describe('git path isolation (F2/F14)', () => {
	it('centralized clones live under the shared/ namespace', () => {
		assert.ok(getRepoPath('my-app').startsWith(joinPath(GIT_REPOS_DIR, 'shared')));
		assert.match(getRepoPath('my-app'), /\/shared\/my-app$/);
	});

	it('centralized and stack paths can never collide', () => {
		// A repo named like an environment must not share a directory with the
		// per-stack env-scoped stack clones.
		const repoPath = getRepoPath('production');
		const stackEnvPath = stackRepoPath(7, 'production', 'webapp');
		assert.ok(!repoPath.includes('production/webapp'));
		assert.ok(repoPath !== stackEnvPath);
		assert.ok(repoPath.startsWith(joinPath(GIT_REPOS_DIR, 'shared')));
		assert.ok(stackEnvPath.startsWith(GIT_REPOS_DIR) && !stackEnvPath.includes('/shared/'));
	});

	it('stack-mode per-stack path uses stack-<id> when no environment is given', () => {
		assert.equal(stackRepoPath(42), joinPath(GIT_REPOS_DIR, 'stack-42'));
	});

	it('stack-mode per-stack path is env-scoped when an environment name is given', () => {
		assert.equal(stackRepoPath(42, 'production', 'webapp'), joinPath(GIT_REPOS_DIR, 'production/webapp'));
	});

	it('documents the reserved-name collision: env "shared" maps into the centralized namespace', () => {
		// An env named "shared" would place its stack clones at
		// git-repos/shared/<stackName> — the SAME namespace as centralized repo
		// clones. validateEnvName refuses this on create/rename (H5), and the
		// transition refuses to enter centralized while such an env exists, but
		// the path-level collision itself is real and must stay documented here.
		const stackPath = stackRepoPath(9, 'shared', 'webapp');
		assert.equal(stackPath, joinPath(GIT_REPOS_DIR, 'shared/webapp'));
		assert.equal(stackPath, getRepoPath('webapp'));
	});

	it('rejects traversal-prone repository names', () => {
		// '..' survives sanitization (dots are allowed) and must be rejected.
		assert.throws(() => getRepoPath('..'), /Invalid repository name/);
		assert.throws(() => getRepoPath('. '), /Invalid repository name/); // sanitizes to '..'
	});

	it('sanitizes separator characters instead of allowing path traversal', () => {
		// Slashes are replaced by underscores, so no subdirectory is created.
		assert.equal(getRepoPath('a/b'), joinPath(GIT_REPOS_DIR, 'shared', 'a_b'));
		assert.equal(getRepoPath('a\\b'), joinPath(GIT_REPOS_DIR, 'shared', 'a_b'));
	});

	it('sanitizes names that would collide on disk', () => {
		assert.equal(sanitizeRepoName('a b'), sanitizeRepoName('a  b'));
		assert.equal(sanitizeRepoName('A/B'), 'A_B');
		// '..' survives sanitization (dots are allowed) but is rejected by getRepoPath.
		assert.equal(sanitizeRepoName('..'), '..');
		assert.throws(() => getRepoPath('..'), /Invalid repository name/);
	});

	it('getGitReposDir matches the exported root constant', () => {
		assert.equal(getGitReposDir(), GIT_REPOS_DIR);
	});
});

function joinPath(...parts: string[]): string {
	return parts.join('/');
}
