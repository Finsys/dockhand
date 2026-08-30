import { describe, expect, test } from 'bun:test';
import { saveCloseTiming } from '../src/lib/utils/save-close-policy';

// Three separate tests, one per case (not one test with three assertions) -- so a
// failure in one case doesn't hide the other two behind a single aborted test run.
describe('saveCloseTiming', () => {
	test('a plain save closes', () => {
		expect(saveCloseTiming(false, true)).toBe('close');
	});

	test('a successful deploy closes, but only after a delay', () => {
		expect(saveCloseTiming(true, true)).toBe('close-delayed');
	});

	test('a failed deploy stays open', () => {
		expect(saveCloseTiming(true, false)).toBe('stay-open');
	});
});
