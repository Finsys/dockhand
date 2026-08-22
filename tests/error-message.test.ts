/**
 * Unit tests for cleanErrorMsg — turns restic/Docker error text into a readable
 * sentence for the UI. Pure function; extracted from helpers.ts into its own
 * module. The hardest inputs are a KILLED helper's exit detail followed by one or
 * many restic --json PROGRESS lines, and non-string / malformed callers.
 */
import { describe, test, expect } from 'bun:test';
import { cleanErrorMsg } from '../src/lib/server/backups/error-message';

describe('cleanErrorMsg — plain + JSON extraction', () => {
	test('plain string passes through unchanged', () => {
		expect(cleanErrorMsg('Connection refused')).toBe('Connection refused');
	});

	test('strips ANSI escape codes (color output from restic CLI)', () => {
		expect(cleanErrorMsg('\x1b[31mFatal:\x1b[0m bad password')).toBe('Fatal: bad password');
	});

	test('extracts message from pure JSON error', () => {
		expect(cleanErrorMsg('{"message":"wrong password"}')).toBe('wrong password');
	});

	test('extracts message from JSON embedded in prefix text', () => {
		expect(cleanErrorMsg('restic failed: {"message":"network timeout"}')).toBe('restic failed: network timeout');
	});

	test('handles double-escaped newlines in the JSON source (collapsed to space)', () => {
		const input = 'Error: {"message":"line one\\\\nline two"}';
		expect(cleanErrorMsg(input)).toBe('Error: line one line two');
	});

	test('returns original (with ANSI stripped) when no parseable JSON present', () => {
		expect(cleanErrorMsg('Just a regular { error message')).toBe('Just a regular { error message');
	});
});

describe('cleanErrorMsg — killed-helper progress spew', () => {
	test('strips a single trailing progress JSON (message_type, no message)', () => {
		expect(cleanErrorMsg('Container exited with code 137: {"message_type":"status","seconds_elapsed":3,"percent_done":1}'))
			.toBe('Container exited with code 137');
	});

	test('strips MULTIPLE concatenated progress JSONs (the real cancel-log spew)', () => {
		const spew = 'Container exited with code 137: '
			+ '{"message_type":"status","percent_done":0.03,"total_files":4268,"files_done":270} '
			+ '{"message_type":"status","seconds_elapsed":1,"percent_done":0.03,"total_files":6867} '
			+ '{"message_type":"status","seconds_elapsed":1,"percent_done":0}';
		expect(cleanErrorMsg(spew)).toBe('Container exited with code 137');
	});

	test('progress JSON with embedded file paths still collapses to the prefix', () => {
		const spew = 'Container exited with code 137: '
			+ '{"message_type":"status","current_files":["/volumes/x/Atomowe nawyki (2019).epub"]} '
			+ '{"message_type":"status","current_files":["/volumes/y/Religa. Człowiek z sercem w dłoni.pdf"]}';
		expect(cleanErrorMsg(spew)).toBe('Container exited with code 137');
	});

	test('a plain error with no JSON is preserved, not dropped', () => {
		expect(cleanErrorMsg('restic backup failed: repository is already locked'))
			.toBe('restic backup failed: repository is already locked');
	});
});

describe('cleanErrorMsg — safety (never throw, never fabricate)', () => {
	test('non-string callers coerce to raw, never crash', () => {
		// The type says string, but this is exported and runtime can pass anything.
		expect(cleanErrorMsg(undefined as any)).toBe('undefined');
		expect(cleanErrorMsg(null as any)).toBe('null');
		expect(cleanErrorMsg(42 as any)).toBe('42');
		expect(cleanErrorMsg({} as any)).toBe('[object Object]');
		expect(cleanErrorMsg([] as any)).toBe('');
	});

	test('empty string stays empty', () => {
		expect(cleanErrorMsg('')).toBe('');
	});

	test('a non-string JSON message is NOT cast (would give "123"/[object Object]) — raw kept', () => {
		// Only a string `message` is used; anything else falls through to raw so we
		// never surface a misleading "123" or "[object Object]".
		expect(cleanErrorMsg('{"message":123}')).toBe('{"message":123}');
		expect(cleanErrorMsg('{"message":{"nested":1}}')).toBe('{"message":{"nested":1}}');
		expect(cleanErrorMsg('{"message":null}')).toBe('{"message":null}');
	});

	test('malformed / unparseable JSON returns the raw string, not an invented message', () => {
		expect(cleanErrorMsg('{"a":')).toBe('{"a":');
		expect(cleanErrorMsg('}{')).toBe('}{');
		expect(cleanErrorMsg('{{{{')).toBe('{{{{');
	});

	test('NEVER throws — a hostile value whose toString()/toJSON() throws still returns', () => {
		// cleanErrorMsg is on the error path; it must not become the crash. These would
		// throw inside String()/JSON.parse without the global guard.
		const hostileToString = { toString() { throw new Error('boom'); } };
		expect(() => cleanErrorMsg(hostileToString as any)).not.toThrow();
		expect(() => cleanErrorMsg(Symbol('x') as any)).not.toThrow();
		expect(() => cleanErrorMsg({ toJSON() { throw new Error('boom'); } } as any)).not.toThrow();
	});
});
