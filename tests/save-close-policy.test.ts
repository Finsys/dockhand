import { describe, expect, test } from 'bun:test';
import { shouldCloseAfterSave } from '../src/lib/utils/save-close-policy';

describe('shouldCloseAfterSave', () => {
	test('a plain save closes the modal', () => {
		expect(shouldCloseAfterSave(false)).toBe(true);
	});

	test('a save that deploys keeps the modal open so the output stays visible', () => {
		expect(shouldCloseAfterSave(true)).toBe(false);
	});
});
