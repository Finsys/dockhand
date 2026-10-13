import { describe, test, expect } from 'bun:test';
import { releasedEntries } from '../src/lib/utils/changelog-filter';
import { latestReleasedVersion } from '../scripts/generate-changelog-page';
import changelogJson from '../src/lib/data/changelog.json';

describe('releasedEntries', () => {
	test('drops coming-soon (unreleased) entries', () => {
		const entries = [
			{ version: '1.0.48', comingSoon: true },
			{ version: '1.0.47' },
			{ version: '1.0.46', comingSoon: false }
		];
		expect(releasedEntries(entries).map((e) => e.version)).toEqual(['1.0.47', '1.0.46']);
	});

	test('keeps everything when nothing is coming-soon', () => {
		const entries = [{ version: '1.0.47' }, { version: '1.0.46' }];
		expect(releasedEntries(entries)).toHaveLength(2);
	});

	test('empty in, empty out', () => {
		expect(releasedEntries([])).toEqual([]);
	});

	test('the top entry being coming-soon does not become the latest released', () => {
		// The regression case: user on an older build, changelog[0] is an unreleased entry.
		const entries = [
			{ version: '1.0.48', comingSoon: true },
			{ version: '1.0.47' }
		];
		expect(releasedEntries(entries)[0].version).toBe('1.0.47');
	});
});

describe('latestReleasedVersion (landing page JSON-LD softwareVersion)', () => {
	test('skips a coming-soon top entry and resolves to the newest shipped one', () => {
		// The distinguishing case: reading entries[0] here would advertise a version
		// nobody can download.
		expect(
			latestReleasedVersion([
				{ version: '1.0.50', comingSoon: true },
				{ version: '1.0.49' },
				{ version: '1.0.48' }
			] as never)
		).toBe('1.0.49');
	});

	test('resolves to the first entry when nothing is coming-soon', () => {
		expect(
			latestReleasedVersion([{ version: '1.0.49' }, { version: '1.0.48' }] as never)
		).toBe('1.0.49');
	});

	test('returns null when every entry is coming-soon, so the caller leaves the schema alone', () => {
		expect(latestReleasedVersion([{ version: '1.0.50', comingSoon: true }] as never)).toBeNull();
	});

	test('returns null for an empty changelog', () => {
		expect(latestReleasedVersion([])).toBeNull();
	});

	test('the shipped changelog resolves to a version that is not the coming-soon top entry', () => {
		const changelog = changelogJson as { version: string; comingSoon?: boolean }[];
		const resolved = latestReleasedVersion(changelog as never);
		expect(resolved).toBe(changelog.find((e) => !e.comingSoon)!.version);
		if (changelog[0].comingSoon) {
			expect(resolved).not.toBe(changelog[0].version);
		}
	});
});
