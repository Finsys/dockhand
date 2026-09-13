// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import { parseDockerOutput } from '../src/lib/components/ui/error-dialog/error-dialog-core';

describe('parseDockerOutput: compose warning lines', () => {
	test('captures the FULL warning even with escaped quotes inside msg', () => {
		// The real docker-compose line that rendered as a truncated "The \" in the UI.
		const line =
			'time="06.09.2026 18:25:03" level=warning msg="The \\"MISSING_ONE\\" variable is not set. Defaulting to a blank string."';
		const r = parseDockerOutput(line);
		expect(r.warnings).toEqual(['The "MISSING_ONE" variable is not set. Defaulting to a blank string.']);
		expect(r.parsed).toBe(true);
	});

	test('a plain warning with no escaped quotes still works', () => {
		const line = 'time="x" level=warning msg="pull access denied"';
		expect(parseDockerOutput(line).warnings).toEqual(['pull access denied']);
	});

	test('multiple warnings are all captured in full', () => {
		const text = [
			'time="t1" level=warning msg="The \\"A\\" variable is not set."',
			'time="t2" level=warning msg="The \\"B\\" variable is not set."'
		].join('\n');
		expect(parseDockerOutput(text).warnings).toEqual([
			'The "A" variable is not set.',
			'The "B" variable is not set.'
		]);
	});
});

describe('parseDockerOutput: steps and errors', () => {
	test('parses container/network/volume steps', () => {
		const text = [
			'Network foo_frontend Creating',
			'Container foo-web-1 Created',
			'Volume foo_data Created'
		].join('\n');
		const r = parseDockerOutput(text);
		expect(r.steps).toEqual([
			{ action: 'Network foo_frontend', status: 'creating' },
			{ action: 'Container foo-web-1', status: 'created' },
			{ action: 'Volume foo_data', status: 'created' }
		]);
	});

	test('collects error lines', () => {
		const text = 'Error response from daemon: failed to set up container networking';
		const r = parseDockerOutput(text);
		expect(r.error).toContain('failed to set up container networking');
		expect(r.parsed).toBe(true);
	});

	test('a warning-only output does not become an error', () => {
		const line = 'time="x" level=warning msg="The \\"FOO\\" variable is not set."';
		expect(parseDockerOutput(line).error).toBeNull();
	});

	test('empty input parses to nothing', () => {
		const r = parseDockerOutput('');
		expect(r.parsed).toBe(false);
		expect(r.warnings).toEqual([]);
		expect(r.error).toBeNull();
	});
});
