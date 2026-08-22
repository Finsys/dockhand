import { describe, it, expect } from 'bun:test';
import { formatErrorLines } from '../src/lib/utils/format';

describe('formatErrorLines', () => {
	it('puts each [NNNN] log marker on its own line', () => {
		const scanner =
			'All scanners failed: Container exited with code 1: [0000] INFO grype version [0026] WARN error=unable to write /cache/grype: no space left on device [0031] INFO loaded DB status=invalid';
		expect(formatErrorLines(scanner)).toBe(
			'All scanners failed: Container exited with code 1:\n' +
				'[0000] INFO grype version\n' +
				'[0026] WARN error=unable to write /cache/grype: no space left on device\n' +
				'[0031] INFO loaded DB status=invalid'
		);
	});

	it('leaves an empty [] compose field path attached (never splits a field name)', () => {
		const compose =
			'error while interpolating services.whoami.environment.[]: required variable VAULT_POSTGRES_PASSWORD is missing a value';
		// no numeric marker -> stays a single line, field name intact
		expect(formatErrorLines(compose)).toBe(compose);
		expect(formatErrorLines(compose)).not.toContain('\n');
	});

	it('splits only numeric brackets, not word brackets', () => {
		expect(formatErrorLines('a [warn] b [12] c')).toBe('a [warn] b\n[12] c');
	});

	it('handles null/empty', () => {
		expect(formatErrorLines(null)).toBe('');
		expect(formatErrorLines('')).toBe('');
		expect(formatErrorLines('plain error, no markers')).toBe('plain error, no markers');
	});
});
