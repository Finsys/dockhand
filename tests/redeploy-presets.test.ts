/**
 * The redeploy popover's presets and its command preview.
 *
 * The preview is a hand-kept copy of the server's `up` arguments, because a
 * component cannot import from $lib/server. The copy is only worth having while it
 * is true, so the first block below compares it against the real
 * buildComposeOperationArgs for every combination a user can tick. A flag added to
 * the server and not to the preview fails here rather than in a popover that
 * quietly advertises a command nobody runs.
 */

import { describe, expect, test } from 'bun:test';
import { buildComposeOperationArgs } from '../src/lib/server/compose-args';
import {
	REDEPLOY_PRESETS,
	composeCommandFor,
	isPresetActive,
	type DeployChoice
} from '../src/lib/utils/redeploy-presets';

const ALL_CHOICES: DeployChoice[] = [false, true].flatMap((pull) =>
	[false, true].flatMap((build) =>
		[false, true].map((forceRecreate) => ({ pull, build, forceRecreate }))
	)
);

/** What the server would actually run for the same choice. */
function serverCommand(choice: DeployChoice): string {
	const args = buildComposeOperationArgs('up', {
		forceRecreate: choice.forceRecreate,
		build: choice.build,
		...(choice.pull ? { pullPolicy: 'always' as const } : {})
	});
	return `docker compose ${args.join(' ')}`;
}

describe('the preview matches what the server runs', () => {
	test('all eight combinations agree, flag for flag and in order', () => {
		expect(ALL_CHOICES).toHaveLength(8);
		for (const choice of ALL_CHOICES) {
			expect(composeCommandFor(choice)).toBe(serverCommand(choice));
		}
	});

	test('nothing ticked is the plain up that recreates only changed services', () => {
		expect(composeCommandFor({ pull: false, build: false, forceRecreate: false })).toBe(
			'docker compose up -d --remove-orphans'
		);
	});

	test('force recreate is the only difference when it is ticked', () => {
		expect(composeCommandFor({ pull: false, build: false, forceRecreate: true })).toBe(
			'docker compose up -d --remove-orphans --force-recreate'
		);
	});

	test('everything ticked keeps the server flag order', () => {
		expect(composeCommandFor({ pull: true, build: true, forceRecreate: true })).toBe(
			'docker compose up -d --remove-orphans --force-recreate --build --pull always'
		);
	});
});

describe('the presets', () => {
	test('each one names a distinct state', () => {
		const states = REDEPLOY_PRESETS.map((p) => `${p.pull}/${p.forceRecreate}`);
		expect(new Set(states).size).toBe(REDEPLOY_PRESETS.length);
	});

	test('at most one is ever active, so the highlight cannot be ambiguous', () => {
		for (const pull of [false, true]) {
			for (const forceRecreate of [false, true]) {
				const active = REDEPLOY_PRESETS.filter((p) => isPresetActive(p, { pull, forceRecreate }));
				expect(active.length).toBeLessThanOrEqual(1);
			}
		}
	});

	/**
	 * The stack editor opens the popover in one of these states, and a preset has to
	 * be lit in each - an opening state matching none would leave the user with three
	 * inactive buttons and nothing saying where they are.
	 */
	test('every state the stack editor can open in lights a preset', () => {
		const editorDefaults = [
			{ label: 'save & redeploy, no env vars', pull: false, forceRecreate: false },
			{ label: 'save & redeploy, with env vars', pull: false, forceRecreate: true },
			{ label: 'create & start', pull: false, forceRecreate: false }
		];
		for (const d of editorDefaults) {
			const active = REDEPLOY_PRESETS.filter((p) => isPresetActive(p, d));
			expect(active).toHaveLength(1);
		}
	});

	test('a preset leaves build alone, since build follows the compose file', () => {
		for (const p of REDEPLOY_PRESETS) {
			expect(Object.hasOwn(p, 'build')).toBe(false);
		}
	});

	test('applying one is what the labels promise', () => {
		const byLabel = Object.fromEntries(REDEPLOY_PRESETS.map((p) => [p.label, p]));
		expect(composeCommandFor({ ...byLabel['Only changed'], build: false })).toBe(
			'docker compose up -d --remove-orphans'
		);
		expect(composeCommandFor({ ...byLabel['Recreate all'], build: false })).toBe(
			'docker compose up -d --remove-orphans --force-recreate'
		);
		expect(composeCommandFor({ ...byLabel['Pull + recreate'], build: false })).toBe(
			'docker compose up -d --remove-orphans --force-recreate --pull always'
		);
	});
});
