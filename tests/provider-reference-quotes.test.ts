/**
 * #1521: op:// / pass:// references pasted with surrounding quotes (1Password's
 * "Copy Secret Reference" clipboard format) must still be detected as references.
 * stripSurroundingQuotes normalizes for the DETECTION/lookup test only - the stored
 * value is left untouched (keeps #1086's "don't strip quotes on save").
 */

import { describe, test, expect } from 'bun:test';
import { stripSurroundingQuotes } from '../src/lib/server/secretproviders/shared';
// NOTE: do NOT import service-account.ts here - it loads @1password/sdk (a native
// module) at import time, which the unit-test env cannot resolve. Its isReference is
// the identical `stripSurroundingQuotes(value).startsWith('op://')` as connectProvider,
// which IS tested below; the pure helper carries the real quote logic.
import { connectProvider } from '../src/lib/server/secretproviders/connect';
import { protonProvider } from '../src/lib/server/secretproviders/proton';
import { keepassProvider } from '../src/lib/server/secretproviders/keepass';
import { azureKvProvider } from '../src/lib/server/secretproviders/azure-kv';

describe('stripSurroundingQuotes', () => {
	test('strips matching double quotes', () => {
		expect(stripSurroundingQuotes('"op://Vault/Item/field"')).toBe('op://Vault/Item/field');
	});
	test('strips matching single quotes', () => {
		expect(stripSurroundingQuotes("'op://Vault/Item/field'")).toBe('op://Vault/Item/field');
	});
	test('trims whitespace before stripping', () => {
		expect(stripSurroundingQuotes('  "op://v/i/f"  ')).toBe('op://v/i/f');
	});
	test('leaves an unquoted value unchanged (just trimmed)', () => {
		expect(stripSurroundingQuotes('op://v/i/f')).toBe('op://v/i/f');
	});
	test('leaves mismatched / one-sided quotes unchanged', () => {
		expect(stripSurroundingQuotes(`"op://v/i/f'`)).toBe(`"op://v/i/f'`);
		expect(stripSurroundingQuotes('"op://v/i/f')).toBe('"op://v/i/f');
	});
	test('does not strip quotes that are not surrounding', () => {
		expect(stripSurroundingQuotes('no"quote"inside')).toBe('no"quote"inside');
	});
	test('empty quoted string collapses to empty', () => {
		expect(stripSurroundingQuotes('""')).toBe('');
	});
	test('a lone quote char is not a pair', () => {
		expect(stripSurroundingQuotes('"')).toBe('"');
	});
	test('strips quotes around a MULTILINE value (pins the /s dotall flag)', () => {
		// Without the `s` flag, `.` would not match the newline and the quotes would
		// survive - a multi-line secret (e.g. a PEM) pasted with quotes must still strip.
		expect(stripSurroundingQuotes('"line1\nline2"')).toBe('line1\nline2');
	});
});

describe('op:// isReference tolerates surrounding quotes (#1521)', () => {
	for (const [name, p] of [
		['connect', connectProvider],
	] as const) {
		test(`${name}: detects a bare op:// reference`, () => {
			expect(p.isReference('op://Vault/Item/field')).toBe(true);
		});
		test(`${name}: detects a double-quoted op:// reference`, () => {
			expect(p.isReference('"op://Vault/Item/field"')).toBe(true);
		});
		test(`${name}: detects a single-quoted op:// reference`, () => {
			expect(p.isReference("'op://Vault/Item/field'")).toBe(true);
		});
		test(`${name}: a plain value is not a reference`, () => {
			expect(p.isReference('just-a-token')).toBe(false);
			expect(p.isReference('"just-a-token"')).toBe(false);
		});
	}
});

describe('proton pass:// isReference tolerates surrounding quotes (#1521)', () => {
	test('detects bare + quoted pass:// references', () => {
		expect(protonProvider.isReference('pass://Vault/Item/field')).toBe(true);
		expect(protonProvider.isReference('"pass://Vault/Item/field"')).toBe(true);
		expect(protonProvider.isReference("'pass://Vault/Item/field'")).toBe(true);
	});
	test('a plain value is not a reference', () => {
		expect(protonProvider.isReference('"nope"')).toBe(false);
	});
});

describe('keepass:// isReference tolerates surrounding quotes (#1521)', () => {
	test('detects bare + quoted keepass:// references', () => {
		expect(keepassProvider.isReference('keepass://Database/Entry/Password')).toBe(true);
		expect(keepassProvider.isReference('"keepass://Database/Entry/Password"')).toBe(true);
		expect(keepassProvider.isReference("'keepass://Database/Entry/Password'")).toBe(true);
	});
	test('a plain value is not a reference', () => {
		expect(keepassProvider.isReference('"nope"')).toBe(false);
	});
});

describe('azurekv:// isReference tolerates surrounding quotes (#1521)', () => {
	// azure-kv refs are a single segment: azurekv://<name>. The anchored regex broke
	// on the leading quote before the fix.
	test('detects bare + quoted azurekv:// references', () => {
		expect(azureKvProvider.isReference('azurekv://db-password')).toBe(true);
		expect(azureKvProvider.isReference('"azurekv://db-password"')).toBe(true);
		expect(azureKvProvider.isReference("'azurekv://db-password'")).toBe(true);
	});
	test('a plain value is not a reference', () => {
		expect(azureKvProvider.isReference('"nope"')).toBe(false);
	});
});
