import { describe, test, expect } from 'bun:test';
import { surfaceBlockIfNoLines } from '../src/lib/server/secret-redaction';

describe('surfaceBlockIfNoLines (old-agent compatibility)', () => {
	test('reports the response block as one line when no lines arrived', () => {
		const seen: string[] = [];
		surfaceBlockIfNoLines((line) => seen.push(line), 0, 'Container probe-app-1  Started', []);
		expect(seen).toEqual(['Container probe-app-1  Started']);
	});

	test('does not report the block again once lines already arrived', () => {
		const seen: string[] = ['first', 'second'];
		surfaceBlockIfNoLines((line) => seen.push(line), seen.length, 'first\nsecond', []);
		expect(seen).toEqual(['first', 'second']);
	});

	test('does nothing without an onLine callback', () => {
		expect(() => surfaceBlockIfNoLines(undefined, 0, 'some output', [])).not.toThrow();
	});

	test('does nothing when the block is empty or undefined', () => {
		const seen: string[] = [];
		surfaceBlockIfNoLines((line) => seen.push(line), 0, '', []);
		surfaceBlockIfNoLines((line) => seen.push(line), 0, undefined, []);
		expect(seen).toEqual([]);
	});

	test('redacts secrets in the surfaced block, same as a streamed line', () => {
		const seen: string[] = [];
		const secret = 'sup3rsecret-password-42';
		surfaceBlockIfNoLines((line) => seen.push(line), 0, `Error: password=${secret} rejected`, [secret]);
		expect(seen).toEqual(['Error: password=*** rejected']);
	});
});
