/**
 * Unit Tests for Authorization Helper Functions
 *
 * Tests the response helper functions from the authorize module.
 */
import { describe, test, expect } from 'bun:test';
import { unauthorized, forbidden, enterpriseRequired } from '../src/lib/server/authorize';

describe('Authorization Helpers', () => {
	describe('unauthorized', () => {
		test('returns correct error object', () => {
			const result = unauthorized();
			expect(result).toEqual({
				error: 'Authentication required',
				status: 401
			});
		});
	});

	describe('forbidden', () => {
		test('returns default message', () => {
			const result = forbidden();
			expect(result).toEqual({
				error: 'Permission denied',
				status: 403
			});
		});

		test('returns custom message', () => {
			const result = forbidden('Custom reason');
			expect(result).toEqual({
				error: 'Custom reason',
				status: 403
			});
		});
	});

	describe('enterpriseRequired', () => {
		test('returns enterprise required error', () => {
			const result = enterpriseRequired();
			expect(result).toEqual({
				error: 'Enterprise license required',
				status: 403
			});
		});
	});
});
