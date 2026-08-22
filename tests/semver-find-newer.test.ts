/**
 * findNewerVersionTag: the advisory "a newer version is out" decision, against
 * messy real-world tag lists.
 */
import { describe, it, expect } from 'bun:test';
import { findNewerVersionTag, findNewerImageTag, classifyBump } from '../src/lib/server/semver/find-newer';
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
