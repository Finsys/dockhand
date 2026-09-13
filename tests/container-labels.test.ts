/**
 * Unit tests for Dockhand container label controls.
 *
 * Tests the label parsing and behavior for:
 * - dockhand.update (opt-out from auto-updates)
 * - dockhand.hidden (hide from UI)
 * - dockhand.notify (suppress notifications)
 *
 * Run with: bun test tests/unit/container-labels.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
	isUpdateDisabledByLabel,
	isHiddenByLabel,
	isNotifyDisabledByLabel,
	isAdoptDisabledByLabel,
	isStackUnadoptable,
	getDockhandLabels,
	getOrderValue,
	getVersionPatternOverride,
	DOCKHAND_LABELS,
} from '../src/lib/server/container-labels';

// ---------------------------------------------------------------------------
// dockhand.update
// ---------------------------------------------------------------------------

describe('isUpdateDisabledByLabel', () => {
	test('returns false (allow update) when no labels present', () => {
		expect(isUpdateDisabledByLabel(undefined)).toBe(false);
		expect(isUpdateDisabledByLabel(null)).toBe(false);
		expect(isUpdateDisabledByLabel({})).toBe(false);
	});

	test('returns true (skip update) for falsy values', () => {
		expect(isUpdateDisabledByLabel({ 'dockhand.update': 'false' })).toBe(true);
		expect(isUpdateDisabledByLabel({ 'dockhand.update': 'FALSE' })).toBe(true);
		expect(isUpdateDisabledByLabel({ 'dockhand.update': 'False' })).toBe(true);
		expect(isUpdateDisabledByLabel({ 'dockhand.update': 'no' })).toBe(true);
		expect(isUpdateDisabledByLabel({ 'dockhand.update': 'NO' })).toBe(true);
		expect(isUpdateDisabledByLabel({ 'dockhand.update': 'No' })).toBe(true);
		expect(isUpdateDisabledByLabel({ 'dockhand.update': '0' })).toBe(true);
	});

	test('returns false (allow update) for truthy values', () => {
		expect(isUpdateDisabledByLabel({ 'dockhand.update': 'true' })).toBe(false);
		expect(isUpdateDisabledByLabel({ 'dockhand.update': 'TRUE' })).toBe(false);
		expect(isUpdateDisabledByLabel({ 'dockhand.update': 'yes' })).toBe(false);
		expect(isUpdateDisabledByLabel({ 'dockhand.update': 'YES' })).toBe(false);
		expect(isUpdateDisabledByLabel({ 'dockhand.update': '1' })).toBe(false);
	});

	test('returns false (allow update) for unrecognized values', () => {
		expect(isUpdateDisabledByLabel({ 'dockhand.update': 'maybe' })).toBe(false);
		expect(isUpdateDisabledByLabel({ 'dockhand.update': '' })).toBe(false);
		expect(isUpdateDisabledByLabel({ 'dockhand.update': 'disable' })).toBe(false);
	});

	test('handles whitespace in values', () => {
		expect(isUpdateDisabledByLabel({ 'dockhand.update': ' false ' })).toBe(true);
		expect(isUpdateDisabledByLabel({ 'dockhand.update': ' true ' })).toBe(false);
		expect(isUpdateDisabledByLabel({ 'dockhand.update': '  NO  ' })).toBe(true);
	});

	test('ignores unrelated labels', () => {
		expect(isUpdateDisabledByLabel({ 'com.docker.compose.project': 'myapp' })).toBe(false);
		expect(isUpdateDisabledByLabel({
			'com.docker.compose.project': 'myapp',
			'dockhand.update': 'false'
		})).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// dockhand.hidden
// ---------------------------------------------------------------------------

describe('isHiddenByLabel', () => {
	test('returns false (visible) when no labels present', () => {
		expect(isHiddenByLabel(undefined)).toBe(false);
		expect(isHiddenByLabel(null)).toBe(false);
		expect(isHiddenByLabel({})).toBe(false);
	});

	test('returns true (hidden) for truthy values', () => {
		expect(isHiddenByLabel({ 'dockhand.hidden': 'true' })).toBe(true);
		expect(isHiddenByLabel({ 'dockhand.hidden': 'TRUE' })).toBe(true);
		expect(isHiddenByLabel({ 'dockhand.hidden': 'True' })).toBe(true);
		expect(isHiddenByLabel({ 'dockhand.hidden': 'yes' })).toBe(true);
		expect(isHiddenByLabel({ 'dockhand.hidden': 'YES' })).toBe(true);
		expect(isHiddenByLabel({ 'dockhand.hidden': 'Yes' })).toBe(true);
		expect(isHiddenByLabel({ 'dockhand.hidden': '1' })).toBe(true);
	});

	test('returns false (visible) for falsy values', () => {
		expect(isHiddenByLabel({ 'dockhand.hidden': 'false' })).toBe(false);
		expect(isHiddenByLabel({ 'dockhand.hidden': 'no' })).toBe(false);
		expect(isHiddenByLabel({ 'dockhand.hidden': '0' })).toBe(false);
	});

	test('returns false (visible) for unrecognized values', () => {
		expect(isHiddenByLabel({ 'dockhand.hidden': 'hidden' })).toBe(false);
		expect(isHiddenByLabel({ 'dockhand.hidden': '' })).toBe(false);
	});

	test('handles whitespace in values', () => {
		expect(isHiddenByLabel({ 'dockhand.hidden': ' true ' })).toBe(true);
		expect(isHiddenByLabel({ 'dockhand.hidden': '  YES  ' })).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// dockhand.notify
// ---------------------------------------------------------------------------

describe('isNotifyDisabledByLabel', () => {
	test('returns false (notify) when no labels present', () => {
		expect(isNotifyDisabledByLabel(undefined)).toBe(false);
		expect(isNotifyDisabledByLabel(null)).toBe(false);
		expect(isNotifyDisabledByLabel({})).toBe(false);
	});

	test('returns true (suppress) for falsy values', () => {
		expect(isNotifyDisabledByLabel({ 'dockhand.notify': 'false' })).toBe(true);
		expect(isNotifyDisabledByLabel({ 'dockhand.notify': 'FALSE' })).toBe(true);
		expect(isNotifyDisabledByLabel({ 'dockhand.notify': 'no' })).toBe(true);
		expect(isNotifyDisabledByLabel({ 'dockhand.notify': 'NO' })).toBe(true);
		expect(isNotifyDisabledByLabel({ 'dockhand.notify': '0' })).toBe(true);
	});

	test('returns false (notify) for truthy values', () => {
		expect(isNotifyDisabledByLabel({ 'dockhand.notify': 'true' })).toBe(false);
		expect(isNotifyDisabledByLabel({ 'dockhand.notify': 'yes' })).toBe(false);
		expect(isNotifyDisabledByLabel({ 'dockhand.notify': '1' })).toBe(false);
	});

	test('returns false (notify) for unrecognized values', () => {
		expect(isNotifyDisabledByLabel({ 'dockhand.notify': 'off' })).toBe(false);
		expect(isNotifyDisabledByLabel({ 'dockhand.notify': '' })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// getDockhandLabels (combined)
// ---------------------------------------------------------------------------

describe('getDockhandLabels', () => {
	test('returns all defaults when no labels', () => {
		expect(getDockhandLabels({})).toEqual({
			updateDisabled: false,
			hidden: false,
			notifyDisabled: false,
		});
	});

	test('returns all defaults for null/undefined', () => {
		expect(getDockhandLabels(null)).toEqual({
			updateDisabled: false,
			hidden: false,
			notifyDisabled: false,
		});
		expect(getDockhandLabels(undefined)).toEqual({
			updateDisabled: false,
			hidden: false,
			notifyDisabled: false,
		});
	});

	test('parses all labels correctly', () => {
		expect(getDockhandLabels({
			'dockhand.update': 'false',
			'dockhand.hidden': 'true',
			'dockhand.notify': 'no',
		})).toEqual({
			updateDisabled: true,
			hidden: true,
			notifyDisabled: true,
		});
	});

	test('parses mixed labels', () => {
		expect(getDockhandLabels({
			'dockhand.update': 'true',
			'dockhand.hidden': 'false',
			'dockhand.notify': 'yes',
		})).toEqual({
			updateDisabled: false,
			hidden: false,
			notifyDisabled: false,
		});
	});

	test('handles partial label sets', () => {
		expect(getDockhandLabels({
			'dockhand.update': 'no',
		})).toEqual({
			updateDisabled: true,
			hidden: false,
			notifyDisabled: false,
		});
	});

	test('ignores non-dockhand labels', () => {
		expect(getDockhandLabels({
			'com.docker.compose.project': 'mystack',
			'maintainer': 'admin@example.com',
			'dockhand.hidden': 'YES',
		})).toEqual({
			updateDisabled: false,
			hidden: true,
			notifyDisabled: false,
		});
	});
});

// ---------------------------------------------------------------------------
// DOCKHAND_LABELS constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// dockhand.order
// ---------------------------------------------------------------------------

describe('getOrderValue', () => {
	test('returns 0 for null/undefined/empty/missing labels', () => {
		expect(getOrderValue(undefined)).toBe(0);
		expect(getOrderValue(null)).toBe(0);
		expect(getOrderValue({})).toBe(0);
	});

	test('parses valid integers', () => {
		expect(getOrderValue({ 'dockhand.order': '1' })).toBe(1);
		expect(getOrderValue({ 'dockhand.order': '-5' })).toBe(-5);
		expect(getOrderValue({ 'dockhand.order': '100' })).toBe(100);
		expect(getOrderValue({ 'dockhand.order': '0' })).toBe(0);
	});

	test('returns 0 for non-numeric values', () => {
		expect(getOrderValue({ 'dockhand.order': 'abc' })).toBe(0);
		expect(getOrderValue({ 'dockhand.order': 'first' })).toBe(0);
		expect(getOrderValue({ 'dockhand.order': '' })).toBe(0);
	});

	test('truncates floats to integer', () => {
		expect(getOrderValue({ 'dockhand.order': '1.5' })).toBe(1);
		expect(getOrderValue({ 'dockhand.order': '3.9' })).toBe(3);
	});

	test('handles whitespace', () => {
		expect(getOrderValue({ 'dockhand.order': ' 3 ' })).toBe(3);
		expect(getOrderValue({ 'dockhand.order': '  -2  ' })).toBe(-2);
	});
});

describe('DOCKHAND_LABELS constants', () => {
	test('has correct label keys', () => {
		expect(DOCKHAND_LABELS.UPDATE).toBe('dockhand.update');
		expect(DOCKHAND_LABELS.HIDDEN).toBe('dockhand.hidden');
		expect(DOCKHAND_LABELS.NOTIFY).toBe('dockhand.notify');
		expect(DOCKHAND_LABELS.ORDER).toBe('dockhand.order');
	});
});

// ---------------------------------------------------------------------------
// Integration-style: simulated container filtering
// ---------------------------------------------------------------------------

describe('container filtering simulation', () => {
	interface MockContainer {
		id: string;
		name: string;
		labels: Record<string, string>;
	}

	const containers: MockContainer[] = [
		{ id: 'c1', name: 'nginx', labels: {} },
		{ id: 'c2', name: 'redis', labels: { 'dockhand.update': 'false' } },
		{ id: 'c3', name: 'postgres', labels: { 'dockhand.update': 'NO' } },
		{ id: 'c4', name: 'traefik', labels: { 'dockhand.hidden': 'true' } },
		{ id: 'c5', name: 'mqtt', labels: { 'dockhand.notify': 'false' } },
		{ id: 'c6', name: 'app', labels: { 'dockhand.update': 'true' } },
		{ id: 'c7', name: 'socket-proxy', labels: { 'dockhand.update': '0', 'dockhand.hidden': 'YES', 'dockhand.notify': 'NO' } },
	];

	test('filters out update-disabled containers', () => {
		const updatable = containers.filter(c => !isUpdateDisabledByLabel(c.labels));
		expect(updatable.map(c => c.name)).toEqual(['nginx', 'traefik', 'mqtt', 'app']);
	});

	test('filters out hidden containers', () => {
		const visible = containers.filter(c => !isHiddenByLabel(c.labels));
		expect(visible.map(c => c.name)).toEqual(['nginx', 'redis', 'postgres', 'mqtt', 'app']);
	});

	test('filters out notify-disabled containers', () => {
		const notifiable = containers.filter(c => !isNotifyDisabledByLabel(c.labels));
		expect(notifiable.map(c => c.name)).toEqual(['nginx', 'redis', 'postgres', 'traefik', 'app']);
	});

	test('socket-proxy has all three labels active', () => {
		const sp = containers.find(c => c.name === 'socket-proxy')!;
		expect(isUpdateDisabledByLabel(sp.labels)).toBe(true);
		expect(isHiddenByLabel(sp.labels)).toBe(true);
		expect(isNotifyDisabledByLabel(sp.labels)).toBe(true);
	});
});

describe('isAdoptDisabledByLabel', () => {
	test('default (no label) is adoptable', () => {
		expect(isAdoptDisabledByLabel(undefined)).toBe(false);
		expect(isAdoptDisabledByLabel(null)).toBe(false);
		expect(isAdoptDisabledByLabel({})).toBe(false);
	});

	test('explicit false/no/0 disables adoption (case-insensitive)', () => {
		expect(isAdoptDisabledByLabel({ 'dockhand.adopt': 'false' })).toBe(true);
		expect(isAdoptDisabledByLabel({ 'dockhand.adopt': 'FALSE' })).toBe(true);
		expect(isAdoptDisabledByLabel({ 'dockhand.adopt': 'no' })).toBe(true);
		expect(isAdoptDisabledByLabel({ 'dockhand.adopt': '0' })).toBe(true);
	});

	test('true / unrecognized values stay adoptable', () => {
		expect(isAdoptDisabledByLabel({ 'dockhand.adopt': 'true' })).toBe(false);
		expect(isAdoptDisabledByLabel({ 'dockhand.adopt': 'maybe' })).toBe(false);
	});
});

describe('isStackUnadoptable', () => {
	test('false when no container opts out', () => {
		expect(isStackUnadoptable([])).toBe(false);
		expect(isStackUnadoptable([{}, { 'dockhand.update': 'false' }])).toBe(false);
	});

	test('true when ANY container has dockhand.adopt=false', () => {
		expect(isStackUnadoptable([{}, { 'dockhand.adopt': 'false' }])).toBe(true);
		expect(isStackUnadoptable([{ 'dockhand.adopt': 'no' }])).toBe(true);
	});

	test('tolerates null/undefined entries', () => {
		expect(isStackUnadoptable([null, undefined, { 'dockhand.adopt': '0' }])).toBe(true);
		expect(isStackUnadoptable([null, undefined])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// dockhand.version.pattern
// ---------------------------------------------------------------------------
describe('getVersionPatternOverride', () => {
	test('returns null when the label is absent', () => {
		expect(getVersionPatternOverride({})).toBeNull();
		expect(getVersionPatternOverride(null)).toBeNull();
	});

	test('compiles a valid regex: pattern from the label into a RegExp', () => {
		const re = getVersionPatternOverride({
			'dockhand.version.pattern': 'regex:^(?<major>\\d{4})\\.(?<minor>\\d+)\\.(?<patch>\\d+)-[0-9a-f]+$'
		});
		expect(re).toBeInstanceOf(RegExp);
		expect(re!.test('2024.12.5-a1b2c3d')).toBe(true);
	});

	test('returns null for a malformed label (safe fallback)', () => {
		expect(getVersionPatternOverride({ 'dockhand.version.pattern': 'not-a-scheme' })).toBeNull();
		expect(getVersionPatternOverride({ 'dockhand.version.pattern': 'regex:(' })).toBeNull();
	});
});
