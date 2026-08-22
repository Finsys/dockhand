/**
 * stackDirIn is the ONE formula deploy staging WRITES to and backup READS from. If they ever
 * diverge, a deploy stages files to one path while a backup looks at another (#1383 / #1240).
 * These tests pin the formula + normalization so both sides stay byte-identical.
 */
import { describe, test, expect } from 'bun:test';
import { normalizeBaseDir, stackDirIn } from '../src/lib/server/stack-paths';
import { planRemoteStaging } from '../src/lib/server/remote-staging-plan';

describe('normalizeBaseDir', () => {
	test('trims and strips trailing slashes', () => {
		expect(normalizeBaseDir('/data/stacks/')).toBe('/data/stacks');
		expect(normalizeBaseDir('/data/stacks///')).toBe('/data/stacks');
		expect(normalizeBaseDir('  /opt/x  ')).toBe('/opt/x');
		expect(normalizeBaseDir('/data/stacks')).toBe('/data/stacks');
	});
});

describe('stackDirIn', () => {
	test('joins normalized base + verbatim stack name', () => {
		expect(stackDirIn('/data/stacks', 'gitlab')).toBe('/data/stacks/gitlab');
		expect(stackDirIn('/data/stacks/', 'gitlab')).toBe('/data/stacks/gitlab');
	});
	test('does NOT slugify or lowercase the stack name (both sides use it raw)', () => {
		expect(stackDirIn('/base', 'My_Stack-1')).toBe('/base/My_Stack-1');
	});
});

describe('deploy staging and the shared formula agree', () => {
	// planRemoteStaging (the WRITE side) must produce exactly stackDirIn(rsd, stack) - the same
	// value the backup resolver READS as its remoteStacksDirHostPath candidate.
	for (const [rsd, stack] of [
		['/data/stacks', 'gitlab'],
		['/opt/hawser-stacks/', 'adguard'],
		['/srv/x///', 'app_1'],
	] as const) {
		test(`hostDir == stackDirIn for rsd="${rsd}" stack="${stack}"`, () => {
			const plan = planRemoteStaging({
				operation: 'up', remoteStacksDir: rsd, stackName: stack, composeContent: '', hasStackFiles: true,
			});
			expect(plan.stage).toBe(true);
			expect(plan.hostDir).toBe(stackDirIn(rsd, stack));
		});
	}
});
