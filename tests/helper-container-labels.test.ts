/**
 * Dockhand's own short-lived helpers (image scanners and their version checks,
 * backup/restore helpers, probes) are silent and hidden: GET /api/containers
 * filters dockhand.hidden=true, so a list taken while a scan runs does not show
 * the scanner, to the UI or to an API client.
 *
 * Both helper launchers are checked against the real source, since docker.ts
 * cannot be imported here (better-sqlite3 does not load under the test runner).
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	HELPER_CONTAINER_LABELS,
	isHiddenByLabel,
	isNotifyDisabledByLabel
} from '../src/lib/server/container-labels';

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'server', 'docker.ts'), 'utf8');

/** The Labels line of one exported function's container config. */
function labelsLine(fn: string): string {
	const start = SRC.indexOf(`export async function ${fn}(`);
	expect(start).toBeGreaterThan(-1);
	const end = SRC.indexOf('\nexport ', start + 1);
	const line = SRC.slice(start, end).split('\n').find((l) => l.trim().startsWith('Labels:'));
	expect(line).toBeDefined();
	return line!;
}

describe('helper container labels', () => {
	test('hide the helper and silence its notifications', () => {
		expect(isHiddenByLabel(HELPER_CONTAINER_LABELS)).toBe(true);
		expect(isNotifyDisabledByLabel(HELPER_CONTAINER_LABELS)).toBe(true);
	});

	test('a caller can still override either', () => {
		const labels = { ...HELPER_CONTAINER_LABELS, 'dockhand.hidden': 'false' };
		expect(isHiddenByLabel(labels)).toBe(false);
		expect(isNotifyDisabledByLabel(labels)).toBe(true);
	});

	test('runContainerWithStreaming applies them, with the caller labels last', () => {
		expect(labelsLine('runContainerWithStreaming')).toMatch(
			/\.\.\.HELPER_CONTAINER_LABELS,\s*\.\.\.\(options\.labels/
		);
	});

	test('runContainer (scanner version checks) applies them', () => {
		expect(labelsLine('runContainer')).toContain('...HELPER_CONTAINER_LABELS');
	});
});
