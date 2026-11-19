import { describe, test, expect } from 'bun:test';
import { stackFileExecMode } from '../src/lib/server/stack-file-mode';

describe('stackFileExecMode - only executable files carry a mode (git 100644 vs 100755)', () => {
	test('a plain file (0644) returns undefined so the modes map stays sparse', () => {
		expect(stackFileExecMode(0o644)).toBeUndefined();
	});

	test('a user-executable file (0755) becomes 0o755', () => {
		expect(stackFileExecMode(0o755)).toBe(0o755);
	});

	test('the exec bit anywhere (user/group/other) counts', () => {
		expect(stackFileExecMode(0o744)).toBe(0o755); // user-exec only
		expect(stackFileExecMode(0o654)).toBe(0o755); // group-exec only
		expect(stackFileExecMode(0o645)).toBe(0o755); // other-exec only
	});

	test('a readonly non-exec file (0444) returns undefined', () => {
		expect(stackFileExecMode(0o444)).toBeUndefined();
	});

	// A full stat mode includes the file-type bits (0o100644 for a regular file).
	// The exec test must look at the permission bits only, not be fooled by them.
	test('a full stat mode for a regular executable (0o100755) still returns 0o755', () => {
		expect(stackFileExecMode(0o100755)).toBe(0o755);
	});

	test('a full stat mode for a regular plain file (0o100644) returns undefined', () => {
		expect(stackFileExecMode(0o100644)).toBeUndefined();
	});
});
