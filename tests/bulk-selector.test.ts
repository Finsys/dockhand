import { describe, test, expect } from 'bun:test';
import { SELECTOR_VARS, BULK_SELECTOR_VAR } from '../src/lib/utils/bulk-selector';

// The bulk-selector field is a live view of the DOCKHAND_SECRET_SELECTOR env var.
// These mirror the modal's read/write helpers so the sync logic is unit-covered
// without mounting Svelte.
type V = { key: string; value: string; isSecret?: boolean };

function readSelector(vars: V[]): string {
	for (const name of SELECTOR_VARS) {
		const hit = vars.find((v) => v.key.trim() === name);
		if (hit) return hit.value;
	}
	return '';
}
function writeSelector(vars: V[], value: string): V[] {
	const others = vars.filter((v) => !SELECTOR_VARS.includes(v.key.trim()));
	return value.trim() ? [...others, { key: BULK_SELECTOR_VAR, value, isSecret: false }] : others;
}

describe('bulk-selector <-> env row sync', () => {
	test('reads the generic var', () => {
		expect(readSelector([{ key: 'DOCKHAND_SECRET_SELECTOR', value: 'prod' }])).toBe('prod');
	});

	test('reads the legacy OP_ENVIRONMENT_ID (preferred over generic)', () => {
		expect(readSelector([
			{ key: 'DOCKHAND_SECRET_SELECTOR', value: 'generic' },
			{ key: 'OP_ENVIRONMENT_ID', value: 'legacy' }
		])).toBe('legacy');
	});

	test('returns empty when no selector var present', () => {
		expect(readSelector([{ key: 'APP_ENV', value: 'x' }])).toBe('');
		expect(readSelector([])).toBe('');
	});

	test('writing adds the generic row, keeping other vars', () => {
		const out = writeSelector([{ key: 'APP_ENV', value: 'x' }], 'path/to/secret');
		expect(out.find((v) => v.key === 'APP_ENV')?.value).toBe('x');
		const sel = out.find((v) => v.key === BULK_SELECTOR_VAR);
		expect(sel?.value).toBe('path/to/secret');
		expect(sel?.isSecret).toBe(false);
	});

	test('writing normalizes a legacy OP_ENVIRONMENT_ID to the generic name', () => {
		const out = writeSelector([{ key: 'OP_ENVIRONMENT_ID', value: 'old' }], 'new');
		expect(out.some((v) => v.key === 'OP_ENVIRONMENT_ID')).toBe(false);
		expect(out.find((v) => v.key === BULK_SELECTOR_VAR)?.value).toBe('new');
	});

	test('clearing the field REMOVES the env row entirely', () => {
		const out = writeSelector([{ key: 'DOCKHAND_SECRET_SELECTOR', value: 'x' }, { key: 'APP_ENV', value: 'y' }], '');
		expect(out.some((v) => SELECTOR_VARS.includes(v.key))).toBe(false);
		expect(out).toHaveLength(1);
	});

	test('a whitespace-only value clears the row (treated as empty)', () => {
		expect(writeSelector([{ key: 'DOCKHAND_SECRET_SELECTOR', value: 'x' }], '   ')).toHaveLength(0);
	});

	test('round-trips: write then read gives the same value', () => {
		const written = writeSelector([], 'env-1');
		expect(readSelector(written)).toBe('env-1');
	});
});
