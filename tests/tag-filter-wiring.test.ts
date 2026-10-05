/**
 * The per-container tag filters and the digest-watch label, as wiring.
 *
 * The decisions themselves are pure and tested in tag-filter-labels.test.ts and
 * container-labels.test.ts. What those cannot see is whether the result reaches the
 * check: a filter that is computed and then dropped looks exactly like one that
 * works. Neither call site can be imported under bun (both reach the database
 * through their imports), so these read the source - the fallback this repo already
 * uses for that situation (see env-file-values.test.ts).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** Both update paths must agree; a label honoured by one only is a bug people hit. */
const CALLERS = [
	{ name: 'the scheduled check', path: '../src/lib/server/scheduler/tasks/env-update-check.ts' },
	{
		name: 'the manual check',
		path: '../src/routes/api/containers/check-updates/+server.ts'
	}
];

/**
 * Every path that can act on a same-tag digest update. The per-container auto-update
 * is a third cron job of its own: honouring the label in the CHECK but not here
 * would hide the badge and recreate the container anyway.
 */
const DIGEST_PATHS = [
	...CALLERS,
	{
		name: 'the per-container auto-update',
		path: '../src/lib/server/scheduler/tasks/container-update.ts'
	}
];

describe('the tag filters reach the version check', () => {
	for (const caller of CALLERS) {
		test(`${caller.name} passes tagFilter built from the container's labels`, () => {
			const src = read(caller.path);
			const call = src.match(/checkNewerVersion\([\s\S]{0,700}?\)\s*\.catch/);
			expect(call).not.toBeNull();
			expect(call![0]).toMatch(/tagFilter:\s*tagFilterFromLabels\(/);
			// From the container's OWN labels, not an empty object or a constant.
			expect(call![0]).toMatch(/tagFilterFromLabels\(\s*inspectData\.Config\?\.Labels\s*\)/);
		});
	}

	test('the filter narrows the pool before the version comparison', () => {
		// Applied after the comparison it would be decoration: the candidate is already
		// chosen by then.
		const src = read('../src/lib/server/semver/find-newer.ts');
		const poolAt = src.indexOf('applyTagFilter(');
		const compareAt = src.indexOf('compareParts(c.parsed, current) > 0');
		expect(poolAt).toBeGreaterThan(-1);
		expect(compareAt).toBeGreaterThan(-1);
		expect(poolAt).toBeLessThan(compareAt);
	});

	test('the filter reads the options rather than a constant', () => {
		const src = read('../src/lib/server/semver/find-newer.ts');
		expect(src).toMatch(/applyTagFilter\(allTags,\s*options\.tagFilter\)/);
	});
});

describe('the digest-watch label is honoured on every path that can act on it', () => {
	for (const caller of DIGEST_PATHS) {
		test(`${caller.name} consults the label`, () => {
			// Either through the shared decision or the predicate it wraps.
			const src = read(caller.path);
			expect(src).toMatch(/digestUpdateVisible|isDigestWatchDisabledByLabel/);
		});
	}

	test('the check paths use the shared decision rather than spelling it out', () => {
		// Two call sites writing `hasUpdate && !disabled` by hand is how one of them
		// ends up missing the `!`; the shared predicate is unit-tested instead.
		for (const caller of CALLERS) {
			expect(read(caller.path)).toContain('digestUpdateVisible(');
		}
	});

	test('the check paths suppress the result without skipping the container', () => {
		// The point of the label: keep newer-version detection, drop the digest
		// report. An early `continue` would take both.
		for (const caller of CALLERS) {
			const src = read(caller.path);
			const use = src.indexOf('digestUpdateVisible(', src.indexOf('\n\n'));
			expect(use).toBeGreaterThan(-1);
			const block = src.slice(use, use + 400);
			const brace = block.indexOf('}');
			expect(block.slice(0, brace === -1 ? block.length : brace)).not.toMatch(/\bcontinue\b/);
		}
	});

	test('the per-container auto-update skips before pulling', () => {
		// It has no newer-version check to preserve, so the honest action is to skip
		// the whole run - but it must do so BEFORE the pull, not after.
		const src = read('../src/lib/server/scheduler/tasks/container-update.ts');
		const label = src.indexOf('isDigestWatchDisabledByLabel(', src.indexOf('\n\n'));
		const pull = src.indexOf('pullImage(');
		expect(label).toBeGreaterThan(-1);
		expect(pull).toBeGreaterThan(-1);
		expect(label).toBeLessThan(pull);
	});
});
