// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_SECRET_PROVIDER_SETTING,
	parseDefaultProviderId,
	resolveDefaultProviderId
} from '../src/lib/utils/default-secret-provider';

const PROVIDERS = [{ id: 1 }, { id: 4 }, { id: 9 }];

describe('parseDefaultProviderId', () => {
	test('accepts a stored number', () => {
		expect(parseDefaultProviderId(4)).toBe(4);
	});

	test('accepts a numeric string, which a client may send as the PUT body value', () => {
		expect(parseDefaultProviderId('4')).toBe(4);
		expect(parseDefaultProviderId(' 4 ')).toBe(4);
	});

	test('treats an absent or empty setting as no default', () => {
		expect(parseDefaultProviderId(null)).toBeNull();
		expect(parseDefaultProviderId(undefined)).toBeNull();
		expect(parseDefaultProviderId('')).toBeNull();
		expect(parseDefaultProviderId('   ')).toBeNull();
	});

	test('rejects values that cannot be a provider id', () => {
		expect(parseDefaultProviderId('abc')).toBeNull();
		expect(parseDefaultProviderId(0)).toBeNull();
		expect(parseDefaultProviderId(-3)).toBeNull();
		expect(parseDefaultProviderId(1.5)).toBeNull();
		expect(parseDefaultProviderId(Number.NaN)).toBeNull();
		expect(parseDefaultProviderId({ id: 4 })).toBeNull();
		expect(parseDefaultProviderId([4])).toBeNull();
		expect(parseDefaultProviderId(true)).toBeNull();
	});
});

describe('resolveDefaultProviderId', () => {
	test('returns the stored id when the provider still exists', () => {
		expect(resolveDefaultProviderId(4, PROVIDERS)).toBe(4);
		expect(resolveDefaultProviderId('9', PROVIDERS)).toBe(9);
	});

	test('a deleted provider falls back to no selection rather than a dangling id', () => {
		expect(resolveDefaultProviderId(7, PROVIDERS)).toBeNull();
	});

	test('no providers at all resolves to no selection', () => {
		expect(resolveDefaultProviderId(4, [])).toBeNull();
	});

	test('an unset default stays unset even when providers exist', () => {
		expect(resolveDefaultProviderId(null, PROVIDERS)).toBeNull();
	});

	test('a corrupt stored value is ignored instead of throwing', () => {
		expect(resolveDefaultProviderId('not-an-id', PROVIDERS)).toBeNull();
		expect(resolveDefaultProviderId({}, PROVIDERS)).toBeNull();
	});

	test('the settings key is stable, since a rename would silently drop the default', () => {
		expect(DEFAULT_SECRET_PROVIDER_SETTING).toBe('default_secret_provider_id');
	});
});
