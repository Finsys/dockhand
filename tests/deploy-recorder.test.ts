// tests/deploy-recorder.test.ts
import { describe, expect, test } from 'bun:test';
import { shouldRecord } from '../src/lib/server/deploy-recorder';

describe('shouldRecord', () => {
	test('records redacted output lines', () => {
		expect(shouldRecord('progress', { type: 'line', line: 'Container web Started' })).toBe(true);
	});

	test('never records the result event, which carries the unredacted output block', () => {
		// deploy/+server.ts sends { success, output: result.output }, and result.output is
		// stdout || stderr straight from compose -- it never passes through redactLine.
		// Recording it would put secrets on disk permanently.
		expect(shouldRecord('result', { success: true, output: 'DB_PASSWORD=hunter2' })).toBe(false);
	});

	test('does not record the static status labels', () => {
		expect(shouldRecord('progress', { status: 'Deploying stack...' })).toBe(false);
	});

	// TWO conditions carry this guard, and each needs its own case -- otherwise removing
	// one of them leaves every test green. The case below is reached only by the event
	// check: a 'result' payload that DOES carry type: 'line' passes the second condition
	// and is stopped by the first one alone.
	test('rejects a result event even when it carries a line-shaped payload', () => {
		expect(shouldRecord('result', { type: 'line', line: 'Container web Started' })).toBe(false);
	});
});
