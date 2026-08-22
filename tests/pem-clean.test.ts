import { describe, test, expect } from 'bun:test';
import { cleanPem } from '../src/lib/utils/pem';

describe('cleanPem', () => {
	test('returns null for null/undefined/empty', () => {
		expect(cleanPem(null)).toBeNull();
		expect(cleanPem(undefined)).toBeNull();
		expect(cleanPem('')).toBeNull();
	});

	test('trims whitespace from lines', () => {
		const pem = '  -----BEGIN CERTIFICATE-----  \n  abc123  \n  -----END CERTIFICATE-----  ';
		expect(cleanPem(pem)).toBe(
			'-----BEGIN CERTIFICATE-----\nabc123\n-----END CERTIFICATE-----'
		);
	});

	test('removes empty lines', () => {
		const pem = '-----BEGIN CERTIFICATE-----\n\nabc123\n\n-----END CERTIFICATE-----\n\n';
		expect(cleanPem(pem)).toBe(
			'-----BEGIN CERTIFICATE-----\nabc123\n-----END CERTIFICATE-----'
		);
	});

	test('handles already clean PEM', () => {
		const pem = '-----BEGIN CERTIFICATE-----\nabc123\n-----END CERTIFICATE-----';
		expect(cleanPem(pem)).toBe(pem);
	});

	test('returns null for whitespace-only input', () => {
		expect(cleanPem('   \n  \n  ')).toBeNull();
	});

	test('handles copy-paste artifacts with tabs', () => {
		const pem = '\t-----BEGIN CERTIFICATE-----\t\n\tabc123\t\n\t-----END CERTIFICATE-----\t';
		expect(cleanPem(pem)).toBe(
			'-----BEGIN CERTIFICATE-----\nabc123\n-----END CERTIFICATE-----'
		);
	});
});
