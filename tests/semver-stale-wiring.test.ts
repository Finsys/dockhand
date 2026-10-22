/**
 * The stale-candidate rule is only worth anything if it is actually handed to the
 * check. The decision itself is pure and tested in semver-find-newer.test.ts; what
 * cannot be tested there is the WIRING, because semver/check.ts reaches the database
 * through its imports and bun cannot load better-sqlite3.
 *
 * So these read the source. Source assertions are the fallback this repo already uses
 * for exactly this situation (see env-file-values.test.ts). They catch the failure
 * that unit tests cannot see: a staleCheck that is computed and then dropped on the
 * floor, which looks identical to one that works.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const SCHEDULED = '../src/lib/server/scheduler/tasks/env-update-check.ts';
const MANUAL = '../src/routes/api/containers/check-updates/+server.ts';

/** Both paths run the same check and must not disagree about what counts as newer. */
const CALLERS = [
	{ name: 'the scheduled check', path: SCHEDULED },
	{ name: 'the manual Check for updates', path: MANUAL }
];

describe('every caller hands the stale check to checkNewerVersion', () => {
	for (const caller of CALLERS) {
		test(`${caller.name} passes staleCheck`, () => {
			const src = read(caller.path);
			// The call spans lines, so match from the function name to its closing
			// paren-and-catch rather than assuming a single line.
			const call = src.match(/checkNewerVersion\([\s\S]{0,600}?\)\s*\.catch/);
			expect(call).not.toBeNull();
			expect(call![0]).toContain('staleCheck');
		});

		test(`${caller.name} builds staleCheck from the stored flag`, () => {
			const src = read(caller.path);
			expect(src).toContain('rejectOlderImages');
			// The running image's own build date is the thing compared against.
			expect(src).toContain('currentCreatedAt');
		});

		test(`${caller.name} scopes the candidate lookup to the target environment`, () => {
			// Without an env id the candidate's platform is resolved against Dockhand's
			// own daemon, so a remote environment would be judged by the wrong os/arch.
			const src = read(caller.path);
			const probe = src.match(/getRegistryTagCreatedAt\([^)]*\)/);
			expect(probe).not.toBeNull();
			expect(probe![0]).toMatch(/env(Id|IdNum|ironmentId)/);
		});

		test(`${caller.name} skips the extra inspect for a floating tag`, () => {
			// checkNewerVersion short-circuits on a floating tag, so reading the running
			// image's date first would be a round-trip bought for nothing.
			const src = read(caller.path);
			expect(src).toMatch(/rejectOlderImages\s*&&[\s\S]{0,120}parseTag\(/);
		});
	}
});

describe('the probe reaches the real registry reader', () => {
	test('getRegistryTagCreatedAt forwards its env id', () => {
		const src = read('../src/lib/server/docker.ts');
		const fn = src.match(/export async function getRegistryTagCreatedAt[\s\S]{0,400}?\n}/);
		expect(fn).not.toBeNull();
		// Third positional argument of getRegistryImageCreatedAt is the env id.
		expect(fn![0]).toMatch(/getRegistryImageCreatedAt\(`\$\{registry\}\/\$\{repo\}`,\s*digest,\s*envId\)/);
	});
});

describe('the stale rule is applied in the right direction', () => {
	// A negated test here inverts the whole feature: it would reject every candidate
	// whose date checks out and offer the stale ones. The pure function is tested
	// elsewhere; what this pins is the sense of the call in the probe.
	test('a stale candidate is the one rejected', () => {
		const src = readFileSync(new URL('../src/lib/server/semver/check.ts', import.meta.url), 'utf8');
		expect(src).toMatch(/if \(isStaleCandidate\([^)]*\)\) return \{ ok: false \}/);
		expect(src).not.toMatch(/if \(!isStaleCandidate\(/);
	});
});
