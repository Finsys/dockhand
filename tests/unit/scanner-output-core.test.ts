import { describe, test, expect } from 'bun:test';
import { truncateForLog, classifyUnparseableOutput } from '../../src/lib/server/scanner-output-core';

describe('truncateForLog', () => {
	test('short output passes through unchanged', () => {
		const s = 'a small error line';
		expect(truncateForLog(s)).toBe(s);
	});
	test('output at exactly 2*keep is unchanged', () => {
		const s = 'x'.repeat(20);
		expect(truncateForLog(s, 10)).toBe(s);
	});
	test('large output is bounded to head + tail with an elision marker', () => {
		const s = 'H'.repeat(50) + 'M'.repeat(1000) + 'T'.repeat(50);
		const out = truncateForLog(s, 10);
		expect(out.startsWith('HHHHHHHHHH')).toBe(true);
		expect(out.endsWith('TTTTTTTTTT')).toBe(true);
		expect(out).toContain('bytes elided');
		// only head(10) + tail(10) + marker - far shorter than the 1100-char input
		expect(out.length).toBeLessThan(100);
		// the elided count is the middle
		expect(out).toContain(`[${s.length - 20} bytes elided]`);
	});
});

describe('classifyUnparseableOutput', () => {
	test('a large buffer not starting with { is truncated (log rotation)', () => {
		// mimic the #1496 fragment: starts mid-JSON (leading spaces then a value)
		const frag = '        "https://ubuntu.com/security/notices/USN-1"\n' + 'x'.repeat(200_000);
		expect(classifyUnparseableOutput(frag)).toBe('truncated');
	});
	test('a short non-JSON line is a CLI error message', () => {
		expect(classifyUnparseableOutput('FATAL failed to download vulnerability DB')).toBe('cli-error');
	});
	test('leading whitespace before { is not misread as an error', () => {
		// a genuine (if unparseable-later) JSON doc that does start with { after trim
		expect(classifyUnparseableOutput('   \n  { "SchemaVersion": 2 ')).toBe('unknown');
	});
	test('a large fragment that happens to start with { is not "truncated"', () => {
		// only a NON-brace lead signals a lost head; a brace-led large blob is "unknown"
		const big = '{' + 'x'.repeat(200_000);
		expect(classifyUnparseableOutput(big)).toBe('unknown');
	});
	test('empty output is unknown, not a cli-error', () => {
		expect(classifyUnparseableOutput('')).toBe('unknown');
	});
});
