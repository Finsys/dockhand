/**
 * findNewerVersionTag: the advisory "a newer version is out" decision, against
 * messy real-world tag lists.
 */
import { describe, it, expect } from 'bun:test';
import { findNewerVersionTag, findNewerImageTag, classifyBump, isRedundantNewerVersion, isStaleCandidate } from '../src/lib/server/semver/find-newer';
import { parseTag } from '../src/lib/server/semver/tag-parser';

describe('findNewerVersionTag — happy paths', () => {
	it('finds the highest newer version and lists what was skipped', () => {
		const result = findNewerVersionTag('16.2', ['16.2', '16.3', '16.4', '15.9']);
		expect(result).toEqual({ tag: '16.4', bump: 'minor', skipped: ['16.3', '16.4'] });
	});

	it('respects flavor: 1.0-alpine only considers -alpine tags', () => {
		const result = findNewerVersionTag('1.0-alpine', ['1.1-alpine', '2.0', '1.2', '1.5-alpine']);
		expect(result?.tag).toBe('1.5-alpine');
		expect(result?.skipped).toEqual(['1.1-alpine', '1.5-alpine']);
	});

	it('treats v-prefix and bare as the same series', () => {
		expect(findNewerVersionTag('v3.0', ['v3.1', '3.2', 'v2.9'])?.tag).toBe('3.2');
	});

	it('collapses the same version published both with and without v-prefix', () => {
		// A registry (e.g. traefik) offers v3.6 AND 3.6 for the same release.
		const result = findNewerVersionTag('v3.0', ['v3.6', '3.6', 'v3.7', '3.7']);
		// One entry per version, prefix matching the running tag (v3.0 -> v-prefixed).
		expect(result?.skipped).toEqual(['v3.6', 'v3.7']);
		expect(result?.tag).toBe('v3.7');
	});

	it('collapses the same version with different segment arity (1.2 and 1.2.0)', () => {
		// 1.2 and 1.2.0 are equal under compareParts - must not both appear in skipped.
		const result = findNewerVersionTag('1.1', ['1.2', '1.2.0']);
		expect(result?.skipped).toHaveLength(1);
		expect(result?.bump).toBe('minor');
	});

	it('handles CalVer (Home Assistant)', () => {
		const result = findNewerVersionTag('2024.1.3', ['2024.1.4', '2024.2.0', '2023.12.1']);
		expect(result?.tag).toBe('2024.2.0');
	});

	it('tolerates version gaps (1.0.1 -> 1.0.5 with nothing between)', () => {
		expect(findNewerVersionTag('1.0.1', ['1.0.5'])?.tag).toBe('1.0.5');
	});
});

describe('findNewerVersionTag — nothing to offer', () => {
	it('returns null for a floating current tag', () => {
		for (const tag of ['latest', 'stable', 'main', 'sha256deadbeef']) {
			expect(findNewerVersionTag(tag, ['1.0', '2.0', '3.0'])).toBeNull();
		}
	});

	it('returns null when nothing is newer', () => {
		expect(findNewerVersionTag('2.0', ['1.0', '1.9', '2.0'])).toBeNull();
	});

	it('returns null when only other-flavor tags are newer', () => {
		expect(findNewerVersionTag('1.0-alpine', ['2.0', '2.0-slim'])).toBeNull();
	});
});

describe('findNewerVersionTag — prereleases', () => {
	// Prereleases are a FILTER (show/hide), not a comparable progression: two tags
	// that differ only in the prerelease part (rc1 vs rc2) share the same numeric
	// version, so neither is "newer" than the other. Scope: we surface a newer
	// STABLE version, and (opt-in) a newer version that happens to be a prerelease.
	it('hides prereleases by default', () => {
		expect(findNewerVersionTag('1.0.0', ['1.1.0-rc1', '1.0.5'])?.tag).toBe('1.0.5');
	});

	it('offers a higher-version prerelease when the current tag is itself a prerelease', () => {
		// current 1.0.0-rc1 -> 1.2.0-rc1 is a real numeric bump, same rc flavor.
		expect(findNewerVersionTag('1.0.0-rc1', ['1.2.0-rc1', '0.9.0-rc1'])?.tag).toBe('1.2.0-rc1');
	});

	it('offers a higher-version prerelease when explicitly opted in (same base flavor)', () => {
		expect(
			findNewerVersionTag('1.0.0-alpine', ['1.1.0-alpine-rc1'], { includePrerelease: true })?.tag
		).toBe('1.1.0-alpine-rc1');
	});

	it('does not treat rc1 -> rc2 (same numeric version) as newer', () => {
		expect(findNewerVersionTag('1.0.0-rc1', ['1.0.0-rc2', '1.0.0-rc3'])).toBeNull();
	});
});

describe('findNewerVersionTag — maxBump cap', () => {
	const tags = ['1.0.2', '1.1.0', '2.0.0'];

	it('patch-only stays on the patch line', () => {
		expect(findNewerVersionTag('1.0.1', tags, { maxBump: 'patch' })?.tag).toBe('1.0.2');
	});
	it('minor allows minor but not major', () => {
		expect(findNewerVersionTag('1.0.1', tags, { maxBump: 'minor' })?.tag).toBe('1.1.0');
	});
	it('major (default) allows everything', () => {
		expect(findNewerVersionTag('1.0.1', tags)?.tag).toBe('2.0.0');
	});
});

describe('classifyBump', () => {
	const bump = (a: string, b: string) => classifyBump(parseTag(a)!, parseTag(b)!);
	it('classifies major/minor/patch by the first differing segment', () => {
		expect(bump('1.2.3', '2.0.0')).toBe('major');
		expect(bump('1.2.3', '1.3.0')).toBe('minor');
		expect(bump('1.2.3', '1.2.4')).toBe('patch');
	});
});

describe('findNewerImageTag — skip non-image (Helm chart) tags', () => {
	// The monorepo case: a repo ships image tags AND a higher chart tag. The chart
	// must not be offered; the highest real IMAGE version is.
	it('falls back to the highest image version when the top tag is a chart', async () => {
		const charts = new Set(['2.1.29']); // chart tag, higher than any image tag
		const probe = async (t: string) => ({ ok: !charts.has(t) });
		const r = await findNewerImageTag('1.5.0', ['1.5.0', '1.6.0', '1.6.11', '2.1.29'], probe);
		expect(r?.tag).toBe('1.6.11');
	});

	it('skips several stacked chart tags to reach a real image', async () => {
		const charts = new Set(['3.0.0', '2.9.0', '2.8.0']);
		const probe = async (t: string) => ({ ok: !charts.has(t) });
		const r = await findNewerImageTag('1.0.0', ['1.0.0', '2.0.0', '2.8.0', '2.9.0', '3.0.0'], probe);
		expect(r?.tag).toBe('2.0.0');
	});

	it('returns null when every newer tag is a chart/artifact', async () => {
		const probe = async () => ({ ok: false }); // nothing is an image
		const r = await findNewerImageTag('1.0.0', ['1.0.0', '1.1.0', '1.2.0'], probe);
		expect(r).toBeNull();
	});

	it('offers the top tag unchanged when it is a real image (one probe, happy path)', async () => {
		let probes = 0;
		const probe = async () => { probes++; return { ok: true }; };
		const r = await findNewerImageTag('1.0.0', ['1.0.0', '1.1.0', '1.2.0'], probe);
		expect(r?.tag).toBe('1.2.0');
		expect(probes).toBe(1); // only the chosen candidate is probed
	});

	it('attaches the target digest when the probe returns one', async () => {
		const probe = async () => ({ ok: true, digest: 'sha256:deadbeef' });
		const r = await findNewerImageTag('1.0.0', ['1.0.0', '1.2.0'], probe);
		expect(r?.tag).toBe('1.2.0');
		expect(r?.digest).toBe('sha256:deadbeef');
	});

	it('omits digest when the probe has none', async () => {
		const probe = async () => ({ ok: true, digest: null });
		const r = await findNewerImageTag('1.0.0', ['1.0.0', '1.2.0'], probe);
		expect(r?.digest).toBeUndefined();
	});

	it('is bounded by maxSkips (a repo full of charts cannot fan out unbounded)', async () => {
		let probes = 0;
		const probe = async () => { probes++; return { ok: false }; };
		await findNewerImageTag('1.0.0', ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0', '1.5.0', '1.6.0', '1.7.0'], probe, {}, 2);
		expect(probes).toBeLessThanOrEqual(3); // maxSkips=2 -> at most 3 attempts
	});
});

describe('isRedundantNewerVersion', () => {
	const D = 'sha256:ab1c3dd381940233af12512b97d47b508fd3a0f17fbe3ba388739b7bc17cbc0b';
	it('true when the candidate digest equals a running-image digest (mariadb 12.3 == 12.3.3)', () => {
		// The real #1572 case: 12.3.3 resolves to the same index digest the 12.3 tag runs.
		expect(isRedundantNewerVersion(D, [D])).toBe(true);
	});
	it('true when it matches ANY of several local digests', () => {
		expect(isRedundantNewerVersion(D, ['sha256:other', D])).toBe(true);
	});
	it('false when the candidate is a genuinely different image (a real 12.3.4)', () => {
		expect(isRedundantNewerVersion('sha256:different', [D])).toBe(false);
	});
	it('false (never suppress) when either side has no digest', () => {
		expect(isRedundantNewerVersion(null, [D])).toBe(false);
		expect(isRedundantNewerVersion(undefined, [D])).toBe(false);
		expect(isRedundantNewerVersion(D, [])).toBe(false);
		expect(isRedundantNewerVersion(D, [null, undefined])).toBe(false);
	});
	it('matches when the running image recorded the per-arch CHILD digest (#1367 shape)', () => {
		// local = child digest; candidate index digest differs, but its child digests
		// include the local one -> same image, must suppress.
		const child = 'sha256:childaaaa';
		expect(isRedundantNewerVersion('sha256:indexdiff', [child], [child, 'sha256:otherarch'])).toBe(true);
	});
	it('false when neither index nor any child digest matches (a real different image)', () => {
		expect(isRedundantNewerVersion('sha256:indexnew', ['sha256:localchild'], ['sha256:arch1', 'sha256:arch2'])).toBe(false);
	});
});

describe('findNewerImageTag suppresses a same-digest candidate (#1572)', () => {
	const RUNNING = 'sha256:running';
	// The probe marks the running-digest candidate `redundant`, mirroring what
	// checkNewerVersion does via isRedundantNewerVersion.
	const probeFor = (digestByTag: Record<string, string>) => async (tag: string) => {
		const digest = digestByTag[tag];
		if (digest && digest === RUNNING) return { ok: false, redundant: true };
		return { ok: true, digest };
	};

	it('returns null when the highest newer tag is the same image already running', async () => {
		// The real #1572 case: current 12.3, highest tag 12.3.3 == running digest.
		const r = await findNewerImageTag('12.3', ['12.3', '12.3.3'], probeFor({ '12.3.3': RUNNING }), {});
		expect(r).toBeNull();
	});

	it('does NOT downgrade to a lower patch when the highest tag is redundant', async () => {
		// 12.3.3 (highest) == running; 12.3.2 is a DIFFERENT (older) image. Must not
		// offer 12.3.2 as an "update" - that would be a downgrade.
		const r = await findNewerImageTag('12.3', ['12.3', '12.3.2', '12.3.3'], probeFor({ '12.3.3': RUNNING, '12.3.2': 'sha256:older' }), {});
		expect(r).toBeNull();
	});

	it('still offers a genuinely newer tag when the highest is NOT the running image', async () => {
		// 12.3.4 exists with a new digest -> a real update, offered.
		const r = await findNewerImageTag('12.3', ['12.3', '12.3.3', '12.3.4'], probeFor({ '12.3.3': RUNNING, '12.3.4': 'sha256:new' }), {});
		expect(r?.tag).toBe('12.3.4');
	});
});

describe('isStaleCandidate', () => {
	// A version tag names what a maintainer called a build, not when it was made.
	// linuxserver/lidarr still carries `8.1.2135` (really 0.8.1.2135, built 2021)
	// which sorts above a current `3.1.0` built in 2026.
	it('rejects a candidate built before the running image', () => {
		expect(isStaleCandidate('2021-11-06T15:03:15Z', '2026-09-23T00:00:00Z')).toBe(true);
	});

	it('keeps a candidate built after the running image', () => {
		expect(isStaleCandidate('2026-09-30T00:00:00Z', '2026-09-23T00:00:00Z')).toBe(false);
	});

	it('keeps a candidate built at the same instant', () => {
		// Not older, so not stale. A rebuild of the same source is still offered.
		expect(isStaleCandidate('2026-09-23T00:00:00Z', '2026-09-23T00:00:00Z')).toBe(false);
	});

	it('keeps the candidate when either date is unknown', () => {
		// Fail-open: a registry that will not answer must never hide a real update.
		expect(isStaleCandidate(null, '2026-09-23T00:00:00Z')).toBe(false);
		expect(isStaleCandidate('2021-11-06T15:03:15Z', null)).toBe(false);
		expect(isStaleCandidate(undefined, undefined)).toBe(false);
		expect(isStaleCandidate('', '2026-09-23T00:00:00Z')).toBe(false);
	});

	it('keeps the candidate when either date is unparseable', () => {
		expect(isStaleCandidate('not-a-date', '2026-09-23T00:00:00Z')).toBe(false);
		expect(isStaleCandidate('2021-11-06T15:03:15Z', 'whenever')).toBe(false);
	});

	it('compares instants, not strings, across offsets', () => {
		// 2026-09-23T01:00:00+02:00 is 2026-09-22T23:00:00Z - older than the running
		// image, even though the string sorts higher.
		expect(isStaleCandidate('2026-09-23T01:00:00+02:00', '2026-09-23T00:00:00Z')).toBe(true);
	});
});

describe('findNewerImageTag drops a stale candidate and keeps looking', () => {
	// The reported shape: the highest-sorting tag is an ancient build, but a real
	// newer version sits below it.
	const probeWith = (staleTags: Set<string>) => async (tag: string) => ({
		ok: !staleTags.has(tag),
		digest: `sha256:${tag}`
	});

	it('skips the stale tag and offers the next-highest real version', async () => {
		const result = await findNewerImageTag(
			'3.1.0',
			['3.1.0', '3.1.1', '8.1.2135'],
			probeWith(new Set(['8.1.2135']))
		);
		expect(result?.tag).toBe('3.1.1');
	});

	it('returns null when every newer tag is stale', async () => {
		const result = await findNewerImageTag(
			'4.0.20',
			['4.0.20', '5.14'],
			probeWith(new Set(['5.14']))
		);
		expect(result).toBeNull();
	});

	it('still offers a genuine newer version when nothing is stale', async () => {
		const result = await findNewerImageTag(
			'3.1.0',
			['3.1.0', '3.1.1', '3.2.0'],
			probeWith(new Set())
		);
		expect(result?.tag).toBe('3.2.0');
	});
});
