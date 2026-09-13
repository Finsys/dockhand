/**
 * Tag parser: extract a comparable version out of real-world Docker tags.
 */
import { describe, it, expect } from 'bun:test';
import {
	parseTag,
	prefixMatches,
	flavorMatches,
	compareParts,
	isPrerelease,
	compileVersionPattern
} from '../src/lib/server/semver/tag-parser';
import { findNewerVersionTag } from '../src/lib/server/semver/find-newer';

describe('parseTag', () => {
	it('splits a plain semver tag', () => {
		expect(parseTag('1.2.3')).toEqual({ version: '1.2.3', prefix: '', suffix: '', parts: [1, 2, 3] });
	});

	it('captures a v-prefix and an -alpine suffix', () => {
		expect(parseTag('v1.25-alpine')).toEqual({
			version: '1.25',
			prefix: 'v',
			suffix: '-alpine',
			parts: [1, 25]
		});
	});

	it('handles CalVer (Home Assistant) as a plain numeric tuple', () => {
		expect(parseTag('2024.1.3')).toEqual({ version: '2024.1.3', prefix: '', suffix: '', parts: [2024, 1, 3] });
	});

	it('keeps a linuxserver -ls suffix as the flavor', () => {
		const p = parseTag('1.20.0-ls123')!;
		expect(p.version).toBe('1.20.0');
		expect(p.suffix).toBe('-ls123');
	});

	it('parses a 4-segment version', () => {
		expect(parseTag('1.2.3.4')!.parts).toEqual([1, 2, 3, 4]);
	});

	it('returns null for floating / non-version tags', () => {
		for (const tag of ['latest', 'stable', 'main', 'edge', 'dev', 'sha256abc']) {
			expect(parseTag(tag)).toBeNull();
		}
	});
});

describe('prefixMatches', () => {
	it('treats "" and "v" as equal', () => {
		expect(prefixMatches('', 'v')).toBe(true);
		expect(prefixMatches('v', '')).toBe(true);
	});
	it('distinguishes a real prefix', () => {
		expect(prefixMatches('release-', 'v')).toBe(false);
	});
});

describe('flavorMatches', () => {
	it('is an exact suffix match', () => {
		expect(flavorMatches(parseTag('1.0-alpine')!, parseTag('2.0-alpine')!)).toBe(true);
		expect(flavorMatches(parseTag('1.0-alpine')!, parseTag('2.0')!)).toBe(false);
		expect(flavorMatches(parseTag('1.0-alpine')!, parseTag('2.0-alpine3.19')!)).toBe(false);
	});

	it('collapses a trailing commit hash so hashed releases share a flavor (searxng)', () => {
		// searxng publishes 2026.8.16-<git hash>; every release has a different hash,
		// so without stripping it nothing would ever match.
		expect(flavorMatches(parseTag('2026.8.15-a1b2c3d')!, parseTag('2026.8.16-b2da6b9')!)).toBe(true);
	});

	it('keeps a real build variant that only looks hex-ish, and a numeric build', () => {
		// -ubuntu22.04 / -ls123 are variants, not hashes; a pure-numeric build isn't a hash.
		expect(flavorMatches(parseTag('1.0-ubuntu22.04')!, parseTag('2.0-ubuntu22.04')!)).toBe(true);
		expect(flavorMatches(parseTag('1.0-ubuntu22.04')!, parseTag('2.0')!)).toBe(false);
		expect(flavorMatches(parseTag('1.0-12345678')!, parseTag('2.0')!)).toBe(false);
	});
});

describe('compareParts', () => {
	it('orders versions with missing segments as 0', () => {
		expect(compareParts(parseTag('1.2')!, parseTag('1.2.0')!)).toBe(0);
		expect(compareParts(parseTag('1.2.1')!, parseTag('1.2')!)).toBeGreaterThan(0);
		expect(compareParts(parseTag('1.10.0')!, parseTag('1.9.0')!)).toBeGreaterThan(0);
	});
	it('orders CalVer correctly', () => {
		expect(compareParts(parseTag('2024.2.0')!, parseTag('2024.1.9')!)).toBeGreaterThan(0);
		expect(compareParts(parseTag('2025.1.0')!, parseTag('2024.12.9')!)).toBeGreaterThan(0);
	});
});

describe('isPrerelease', () => {
	it('flags rc/beta/alpha/nightly/dev/pre channels in the suffix', () => {
		for (const tag of ['1.0.0-rc1', '2.0-beta', '1.5-alpha.2', '3.0-nightly', '1.0-dev', '1.0-pre']) {
			expect(isPrerelease(parseTag(tag)!)).toBe(true);
		}
	});
	it('does not flag a stable release or a plain flavor', () => {
		for (const tag of ['1.0.0', '1.0.0-alpine', '1.0.0-ls123']) {
			expect(isPrerelease(parseTag(tag)!)).toBe(false);
		}
	});
});

describe('compileVersionPattern', () => {
	it('returns null for absent / non-regex-scheme / bad values', () => {
		expect(compileVersionPattern(undefined)).toBeNull();
		expect(compileVersionPattern('')).toBeNull();
		expect(compileVersionPattern('^(?<major>\\d+)$')).toBeNull(); // missing regex: scheme
		expect(compileVersionPattern('regex:(?<minor>\\d+)')).toBeNull(); // no major group
		expect(compileVersionPattern('regex:(')).toBeNull(); // invalid regex
		expect(compileVersionPattern('regex:' + 'a'.repeat(400))).toBeNull(); // too long
	});

	it('rejects catastrophic-backtracking shapes (ReDoS guard)', () => {
		expect(compileVersionPattern('regex:(?<major>(a+)+)$')).toBeNull();
		expect(compileVersionPattern('regex:(?<major>\\d+)(a*)*$')).toBeNull();
	});

	it('compiles a valid pattern with a major group', () => {
		const re = compileVersionPattern('regex:^(?<major>\\d{4})\\.(?<minor>\\d+)\\.(?<patch>\\d+)-[0-9a-f]+$');
		expect(re).toBeInstanceOf(RegExp);
	});
});

describe('parseTag with a version-pattern override', () => {
	// CalVer + commit hash - the generic parser would read parts wrong / stop early.
	const calver = compileVersionPattern(
		'regex:^(?<major>\\d{4})\\.(?<minor>\\d+)\\.(?<patch>\\d+)-[0-9a-f]+$'
	)!;

	it('parses a CalVer+hash tag into numeric parts', () => {
		const p = parseTag('2024.12.5-a1b2c3d', calver)!;
		expect(p.parts).toEqual([2024, 12, 5]);
	});

	it('treats a tag the override does not match as a non-version (null)', () => {
		expect(parseTag('latest', calver)).toBeNull();
		expect(parseTag('2024.12.5', calver)).toBeNull(); // no hash -> no match
	});

	it('compares two override-parsed tags correctly', () => {
		const a = parseTag('2024.12.5-aaaaaaa', calver)!;
		const b = parseTag('2024.12.6-bbbbbbb', calver)!;
		expect(compareParts(b, a)).toBeGreaterThan(0);
	});

	it('requires only major; missing later groups fill in as present', () => {
		const majorOnly = compileVersionPattern('regex:^build-(?<major>\\d+)$')!;
		expect(parseTag('build-42', majorOnly)!.parts).toEqual([42]);
	});
});

describe('findNewerVersionTag with a version-pattern override', () => {
	const calver = compileVersionPattern(
		'regex:^(?<major>\\d{4})\\.(?<minor>\\d+)\\.(?<patch>\\d+)-[0-9a-f]+$'
	)!;

	it('finds a newer CalVer+hash tag that the default parser would miss', () => {
		const result = findNewerVersionTag(
			'2024.12.5-a1b2c3d',
			['2024.12.5-a1b2c3d', '2024.12.6-b2c3d4e', '2025.1.0-c3d4e5f', 'latest'],
			{ versionPattern: calver }
		);
		expect(result?.tag).toBe('2025.1.0-c3d4e5f');
	});

	it('returns null when the current tag does not match the override', () => {
		const result = findNewerVersionTag('latest', ['2024.12.6-b2c3d4e'], { versionPattern: calver });
		expect(result).toBeNull();
	});
});
