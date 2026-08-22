/**
 * Unit tests for the #675 stack-delete path guard. The critical case: a stack ADOPTED
 * AT THE STACKS ROOT (auto-named "stacks") must NOT be deletable, because its dir IS
 * the stacks root and a non-strict guard would have rmSync'd every other stack.
 */
import { describe, it, expect } from 'bun:test';
import { isDeletableStackDir } from '../src/lib/server/stack-delete-guard';

const STACKS = '/data/stacks';

describe('isDeletableStackDir', () => {
	it('#675: a stack adopted at the stacks ROOT is NOT deletable', () => {
		// compose at /data/stacks/docker-compose.yml -> dir is the root, name is "stacks"
		expect(isDeletableStackDir('/data/stacks', STACKS, 'stacks')).toBe(false);
	});

	it('#675: trailing-slash root form is also NOT deletable', () => {
		expect(isDeletableStackDir('/data/stacks/', STACKS, 'stacks')).toBe(false);
	});

	it('a normal nested stack dir IS deletable', () => {
		expect(isDeletableStackDir('/data/stacks/myapp', STACKS, 'myapp')).toBe(true);
	});

	it('an env-scoped nested stack dir IS deletable', () => {
		expect(isDeletableStackDir('/data/stacks/prod/myapp', STACKS, 'myapp')).toBe(true);
	});

	it('basename must match the stack name', () => {
		// dir exists under stacks but its folder name differs from the stack name
		expect(isDeletableStackDir('/data/stacks/other', STACKS, 'myapp')).toBe(false);
	});

	it('a path OUTSIDE the stacks dir is NOT deletable (adopted-in-place)', () => {
		expect(isDeletableStackDir('/home/user/compose/myapp', STACKS, 'myapp')).toBe(false);
	});

	it('a sibling dir that merely shares the stacks prefix is NOT deletable', () => {
		// /data/stacks-backup startsWith "/data/stacks" but not "/data/stacks/"
		expect(isDeletableStackDir('/data/stacks-backup/myapp', STACKS, 'myapp')).toBe(false);
	});

	it('a "../" escape resolves out and is NOT deletable', () => {
		expect(isDeletableStackDir('/data/stacks/../evil', STACKS, 'evil')).toBe(false);
	});
});
