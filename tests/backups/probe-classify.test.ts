/**
 * Unit tests for classifyProbeListing - the pure part of the host/volume data probe.
 *
 * The probe container's stdout is classified into has-data / empty / missing. The fourth kind,
 * helper-failed (the container could not run at all), is decided by the caller catching the run
 * error, not here - so this classifier never returns it. The missing-vs-empty split is the reason
 * this exists: both otherwise list nothing, so the list-script prints a sentinel when the path is
 * absent, and the classifier keys off it.
 */
import { describe, expect, test } from 'bun:test';
import { classifyProbeListing, PROBE_MISSING_SENTINEL } from '../../src/lib/server/backups/stackdir-plan';

describe('classifyProbeListing', () => {
	test('lines present -> has-data', () => {
		expect(classifyProbeListing('f\t12\tindex.html\nd\t0\tassets\n')).toBe('has-data');
	});

	test('empty stdout (helper ran, dir empty) -> empty', () => {
		expect(classifyProbeListing('')).toBe('empty');
		expect(classifyProbeListing('\n')).toBe('empty');
	});

	test('missing sentinel -> missing (path does not exist on host)', () => {
		expect(classifyProbeListing(PROBE_MISSING_SENTINEL)).toBe('missing');
	});

	test('sentinel wins even if garbage precedes it', () => {
		expect(classifyProbeListing(`noise\n${PROBE_MISSING_SENTINEL}`)).toBe('missing');
	});

	test('malformed lines (no tabs) are ignored -> empty, not has-data', () => {
		expect(classifyProbeListing('not-a-listing-line\nanother')).toBe('empty');
	});
});
