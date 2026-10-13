// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import {
	checkByVersionOnly,
	latestReleasedVersion
} from '../src/lib/utils/self-update-availability';

// On Kubernetes there is no container to inspect, so the image and its digest are
// unknowable. The build stamps in its own version and the changelog names the newest
// release, so the comparison is still possible without any runtime.
const CHANGELOG = [
	{ version: '1.0.55', comingSoon: true },
	{ version: '1.0.54' },
	{ version: '1.0.53' }
];

describe('latestReleasedVersion', () => {
	test('skips an unreleased entry', () => {
		// comingSoon is the version being written, not one anybody can pull.
		expect(latestReleasedVersion(CHANGELOG)).toBe('1.0.54');
	});

	test('takes the first released entry, since the file is newest-first', () => {
		expect(latestReleasedVersion([{ version: '2.0.0' }, { version: '9.9.9' }])).toBe('2.0.0');
	});

	test('a changelog with nothing released yields null', () => {
		expect(latestReleasedVersion([{ version: '1.0.55', comingSoon: true }])).toBe(null);
		expect(latestReleasedVersion([])).toBe(null);
	});

	test('a malformed changelog yields null rather than throwing', () => {
		for (const bad of [null, undefined, 'nope', 42, {}, [{}], [{ version: '' }], [{ version: 7 }]]) {
			expect(latestReleasedVersion(bad)).toBe(null);
		}
	});
});

describe('checkByVersionOnly', () => {
	test('reports an update when the build is behind', () => {
		const r = checkByVersionOnly('v1.0.53', CHANGELOG);
		expect(r.updateAvailable).toBe(true);
		expect(r.latestVersion).toBe('1.0.54');
		expect(r.currentVersion).toBe('1.0.53');
		expect(r.versionOnly).toBe(true);
		expect(r.error).toBeUndefined();
	});

	test('reports no update when the build is current or ahead', () => {
		// Ahead happens on a development build cut after the last release.
		expect(checkByVersionOnly('1.0.54', CHANGELOG).updateAvailable).toBe(false);
		expect(checkByVersionOnly('1.0.55', CHANGELOG).updateAvailable).toBe(false);
		expect(checkByVersionOnly('2.0.0', CHANGELOG).updateAvailable).toBe(false);
	});

	test('the leading v is not part of the version', () => {
		// VERSION carries it, changelog.json does not, so both spellings must agree.
		expect(checkByVersionOnly('v1.0.53', CHANGELOG).updateAvailable).toBe(true);
		expect(checkByVersionOnly('1.0.53', [{ version: 'v1.0.54' }]).updateAvailable).toBe(true);
		// Pins the changelog-side strip on its own: without it 'v1.0.53' would not be
		// a plain version and this would answer with an error instead of 'no update'.
		const same = checkByVersionOnly('1.0.53', [{ version: 'v1.0.53' }]);
		expect(same.updateAvailable).toBe(false);
		expect(same.error).toBeUndefined();
		expect(same.latestVersion).toBe('1.0.53');
		expect(checkByVersionOnly('v1.0.54', [{ version: 'v1.0.54' }]).updateAvailable).toBe(false);
	});

	test('a build with no version gives no verdict, rather than a guess', () => {
		// "up to date" is the one answer an operator cannot check, and claiming an
		// update would nag every unversioned build.
		for (const v of [null, undefined, '', '   ', 'unknown', 'dev']) {
			const r = checkByVersionOnly(v, CHANGELOG);
			expect(r.updateAvailable).toBe(false);
			expect(r.error).toMatch(/does not report a version/i);
			expect(r.latestVersion).toBeUndefined();
		}
	});

	test('a version with a suffix gives no verdict, rather than a wrong one', () => {
		// compareVersions reads dot-separated numbers and zeroes anything else, so
		// 1.0.60-rc1 would compare as 1.0.0 and be called behind 1.0.53 - seven
		// releases the wrong way. Such a version belongs in the no-verdict branch.
		for (const v of ['v1.0.60-rc1', 'v1.0.54-rc1', '1.0.53+build', '1.0.53x', '1.0.53 (dev)']) {
			const r = checkByVersionOnly(v, CHANGELOG);
			expect(r.updateAvailable).toBe(false);
			expect(r.error).toMatch(/does not report a version/i);
		}
		// A shorter but genuinely numeric version is still comparable, and 1.0 really
		// is behind 1.0.54.
		expect(checkByVersionOnly('1.0', CHANGELOG).updateAvailable).toBe(true);
		// The suffix we do publish stays comparable.
		expect(checkByVersionOnly('1.0.53-baseline', CHANGELOG).updateAvailable).toBe(true);
	});

	test('a changelog version that is not plain is reported, not compared', () => {
		// The mirror of the above: a malformed latest would otherwise be zeroed and
		// silently hide a real update.
		const r = checkByVersionOnly('1.0.53', [{ version: '1.0.60-rc1' }]);
		expect(r.updateAvailable).toBe(false);
		expect(r.error).toMatch(/not a plain version/i);
	});

	test('an unreadable changelog is reported, not treated as up to date', () => {
		const r = checkByVersionOnly('1.0.53', [{ version: '1.0.55', comingSoon: true }]);
		expect(r.updateAvailable).toBe(false);
		expect(r.currentVersion).toBe('1.0.53');
		expect(r.error).toMatch(/no released version/i);
	});

	test('the answer always says it rests on versions alone', () => {
		// The client uses this to describe the result instead of offering an update,
		// which only a container runtime could apply.
		for (const args of [
			['1.0.53', CHANGELOG],
			['nope', CHANGELOG],
			['1.0.53', []]
		] as const) {
			expect(checkByVersionOnly(args[0], args[1]).versionOnly).toBe(true);
		}
	});

	test('it never offers an image to pull', () => {
		// Kubernetes replaces the image through the manifest; naming one here would
		// invite an update Dockhand cannot perform.
		const r = checkByVersionOnly('1.0.53', CHANGELOG) as Record<string, unknown>;
		expect(r.newImage).toBeUndefined();
		expect(r.currentImage).toBeUndefined();
		expect(r.containerName).toBeUndefined();
	});
});
