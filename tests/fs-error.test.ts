/**
 * A failure reported as its message alone cannot be told apart from a different fault
 * with similar wording. The code, the syscall and the path are what identify it.
 */
import { describe, test, expect } from 'bun:test';
import { describeFsError } from '../src/lib/server/fs-error';

describe('describeFsError', () => {
	test('carries the code, the syscall, the errno and the path', () => {
		const err = Object.assign(new Error('Invalid src or dest: cp returned EINVAL'), {
			code: 'ERR_FS_CP_EINVAL', syscall: 'cp', errno: 22, path: '/app/data/stacks/x/link-dir'
		});
		const out = describeFsError(err);
		expect(out).toContain('Invalid src or dest');
		expect(out).toContain('code=ERR_FS_CP_EINVAL');
		expect(out).toContain('syscall=cp');
		expect(out).toContain('errno=22');
		expect(out).toContain('/app/data/stacks/x/link-dir');
	});

	test('includes the destination when the error names one', () => {
		const err = Object.assign(new Error('boom'), { code: 'EXDEV', path: '/a', dest: '/b' });
		expect(describeFsError(err)).toContain('dest=/b');
	});

	test('a plain error is returned as its message, with no empty bracket', () => {
		expect(describeFsError(new Error('just a message'))).toBe('just a message');
	});

	test('errno zero is still reported, not dropped as falsy', () => {
		const err = Object.assign(new Error('x'), { errno: 0 });
		expect(describeFsError(err)).toContain('errno=0');
	});

	test('a non-error value is stringified rather than dropped', () => {
		expect(describeFsError('a string failure')).toBe('a string failure');
		expect(describeFsError(undefined)).toBe('undefined');
	});
});
