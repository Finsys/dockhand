/**
 * Tests for the multi-compose change-detection + containment fixes:
 * - getStackDiffDirs: which repo directories trigger a stack redeploy
 * - rebaseGitComposePaths: repo-relative -> on-disk rebase with containment
 * - secureSecretEqual / verifyWebhookSignature: constant-time secret checks
 */
import { describe, it, expect } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
	getStackDiffDirs,
	rebaseGitComposePaths,
	serializeComposePaths
} from '../src/lib/server/compose-files';
import { isPathInside } from '../src/lib/server/git-url-safety';
import { secureSecretEqual, verifyWebhookSignature } from '../src/lib/server/webhook-signature';
import { join } from 'node:path';

describe('getStackDiffDirs', () => {
	it('diffs the single compose file directory when no composePaths/contextDir', () => {
		expect(getStackDiffDirs({ composePath: 'apps/web/compose.yaml' })).toEqual(['apps/web']);
	});

	it('diffs every compose file directory for multi-compose stacks', () => {
		const dirs = getStackDiffDirs({
			composePath: 'apps/web/compose.yaml',
			composePaths: serializeComposePaths(['apps/web/compose.yaml', 'apps/api/compose.yaml'])
		});
		expect(dirs).toEqual(['apps/api', 'apps/web']);
	});

	it('prefers contextDir and prunes nested compose dirs', () => {
		const dirs = getStackDiffDirs({
			composePath: 'apps/web/compose.yaml',
			composePaths: serializeComposePaths(['apps/web/compose.yaml', 'apps/web/sub/compose.yaml']),
			contextDir: 'apps/web'
		});
		expect(dirs).toEqual(['apps/web']);
	});

	it('covers a compose file in a different dir when contextDir is the common root', () => {
		const dirs = getStackDiffDirs({
			composePath: 'apps/web/compose.yaml',
			composePaths: serializeComposePaths(['apps/web/compose.yaml', 'apps/api/compose.yaml']),
			contextDir: 'apps'
		});
		expect(dirs).toEqual(['apps']);
	});

	it('falls back to repo root for a root-level compose file', () => {
		expect(getStackDiffDirs({ composePath: 'compose.yaml' })).toEqual(['.']);
	});

	it('includes the env file directory even when outside the compose dir', () => {
		const dirs = getStackDiffDirs({
			composePath: 'apps/web/compose.yaml',
			envFilePath: 'env/production.env'
		});
		expect(dirs).toEqual(['apps/web', 'env']);
	});
});

describe('rebaseGitComposePaths', () => {
	const workingDir = '/data/stacks/myapp';

	it('rebases a sibling file in the same directory', () => {
		const rebased = rebaseGitComposePaths(
			['apps/web/compose.yaml', 'apps/web/override.yaml'],
			`${workingDir}/`,
			workingDir
		);
		expect(rebased).toEqual([
			`${workingDir}/compose.yaml`,
			`${workingDir}/override.yaml`
		]);
	});

	it('rebases a nested additional file while staying inside the stack dir', () => {
		const rebased = rebaseGitComposePaths(
			['apps/web/compose.yaml', 'apps/web/sub/compose.yaml'],
			`${workingDir}/`,
			workingDir
		);
		expect(rebased).toEqual([
			`${workingDir}/compose.yaml`,
			`${workingDir}/sub/compose.yaml`
		]);
	});

	it('rejects a path that escapes the stack directory', () => {
		expect(() =>
			rebaseGitComposePaths(
				['apps/web/compose.yaml', 'apps/api/compose.yaml'],
				`${workingDir}/`,
				workingDir
			)
		).toThrow(/escapes the stack directory/);
	});

	it('rejects an explicit traversal', () => {
		expect(() =>
			rebaseGitComposePaths(
				['apps/web/compose.yaml', '../../../../etc/passwd'],
				`${workingDir}/`,
				workingDir
			)
		).toThrow(/escapes the stack directory/);
	});

	it('rejects absolute paths for git stacks', () => {
		expect(() =>
			rebaseGitComposePaths(
				['apps/web/compose.yaml', '/etc/passwd'],
				`${workingDir}/`,
				workingDir
			)
		).toThrow(/must be relative to the repository/);
	});

	it('keeps a nested primary layout inside the stack dir', () => {
		const rebased = rebaseGitComposePaths(
			['apps/web/sub/compose.yaml', 'apps/web/compose.yaml'],
			`${workingDir}/sub`,
			workingDir
		);
		expect(rebased).toEqual([
			`${workingDir}/sub/compose.yaml`,
			`${workingDir}/compose.yaml`
		]);
	});
});

describe('compose path containment (saveStackComposeFile multi-compose write)', () => {
	// saveStackComposeFile resolves each relative composeContents key against the
	// stack dir with join() and checks containment with isPathInside. These cases
	// mirror the checks the create/update branch performs before writing.
	const stackDir = '/data/stacks/foo';
	const writeIsAllowed = (key: string) => isPathInside(join(stackDir, key), stackDir);

	it('rejects a sibling-prefix bypass (../foo2/compose.yaml)', () => {
		// stackDir=/data/stacks/foo; the bare startsWith check wrongly allowed this.
		expect(isPathInside('/data/stacks/foo2/compose.yaml', stackDir)).toBe(false);
		expect(writeIsAllowed('../foo2/compose.yaml')).toBe(false);
	});

	it('rejects explicit and deep .. traversal', () => {
		expect(writeIsAllowed('../bar/compose.yaml')).toBe(false);
		expect(writeIsAllowed('../../etc/passwd')).toBe(false);
		expect(writeIsAllowed('sub/../../out/compose.yaml')).toBe(false);
	});

	it('accepts files inside the stack directory', () => {
		expect(writeIsAllowed('compose.yaml')).toBe(true);
		expect(writeIsAllowed('apps/web/compose.yaml')).toBe(true);
		expect(writeIsAllowed('includes/override.yml')).toBe(true);
	});
});

describe('secureSecretEqual', () => {
	it('returns true for equal secrets', () => {
		expect(secureSecretEqual('s3cr3t', 's3cr3t')).toBe(true);
	});

	it('returns false for different secrets', () => {
		expect(secureSecretEqual('s3cr3t', 's3cr4t')).toBe(false);
	});

	it('returns false on length mismatch (no timing leak)', () => {
		expect(secureSecretEqual('short', 'a-much-longer-secret')).toBe(false);
	});

	it('returns false when either value is null', () => {
		expect(secureSecretEqual(null, 's3cr3t')).toBe(false);
		expect(secureSecretEqual('s3cr3t', null)).toBe(false);
		expect(secureSecretEqual(null, null)).toBe(false);
	});
});

describe('verifyWebhookSignature', () => {
	it('accepts a valid GitHub-style HMAC', () => {
		const secret = 's3cr3t';
		const payload = '{"ref":"refs/heads/main"}';
		const sig = 'sha256=' + createHmac('sha256', secret)
			.update(payload)
			.digest('hex');
		expect(verifyWebhookSignature(payload, sig, secret)).toBe(true);
		expect(verifyWebhookSignature(payload, sig, 'wrong')).toBe(false);
	});

	it('accepts a valid GitLab-style token constant-time', () => {
		expect(verifyWebhookSignature('', 'tok3n', 'tok3n')).toBe(true);
		expect(verifyWebhookSignature('', 'tok3n', 'tok4n')).toBe(false);
	});

	it('rejects a missing signature', () => {
		expect(verifyWebhookSignature('', null, 's3cr3t')).toBe(false);
	});
});
