import { describe, it, expect } from 'bun:test';
import {
	STACK_LOG_OPERATIONS,
	DEFAULT_STACK_LOG_OPERATIONS,
	sanitizeStackLogOperations,
	parseStackLogOperationsStorage,
	shouldShowStackLog,
	type StackLogOperation
} from '../src/lib/utils/stack-log-operations';

const ALL = STACK_LOG_OPERATIONS.map((o) => o.key);

describe('stack-log-operations defaults', () => {
	it('default shows every heavy op but the simple start/stop (#1558)', () => {
		expect(DEFAULT_STACK_LOG_OPERATIONS).toEqual(['restart', 'deploy', 'down']);
		expect(DEFAULT_STACK_LOG_OPERATIONS).not.toContain('start');
		expect(DEFAULT_STACK_LOG_OPERATIONS).not.toContain('stop');
	});
	it('remove is not a listed operation (it never opens the log popover)', () => {
		expect(ALL).not.toContain('remove' as StackLogOperation);
	});
});

describe('sanitizeStackLogOperations', () => {
	it('a non-array (unset / garbage) falls back to the default', () => {
		expect(sanitizeStackLogOperations(undefined)).toEqual(DEFAULT_STACK_LOG_OPERATIONS);
		expect(sanitizeStackLogOperations(null)).toEqual(DEFAULT_STACK_LOG_OPERATIONS);
		expect(sanitizeStackLogOperations('start')).toEqual(DEFAULT_STACK_LOG_OPERATIONS);
	});
	it('an explicit empty array is honored as "log nothing", not defaulted', () => {
		expect(sanitizeStackLogOperations([])).toEqual([]);
	});
	it('drops unknown keys and de-duplicates, in canonical order', () => {
		expect(sanitizeStackLogOperations(['down', 'start', 'bogus', 'start', 'remove']))
			.toEqual(['start', 'down']); // 'bogus'/'remove' dropped, dupes removed, canonical order
	});
	it('keeps a full valid selection in canonical order regardless of input order', () => {
		expect(sanitizeStackLogOperations(['down', 'deploy', 'stop', 'restart', 'start']))
			.toEqual(['start', 'stop', 'restart', 'deploy', 'down']);
	});
});

describe('parseStackLogOperationsStorage (the unset-vs-empty KV invariant)', () => {
	it('an UNSET value (null/undefined) uses the default, not "log nothing"', () => {
		expect(parseStackLogOperationsStorage(null)).toEqual(DEFAULT_STACK_LOG_OPERATIONS);
		expect(parseStackLogOperationsStorage(undefined)).toEqual(DEFAULT_STACK_LOG_OPERATIONS);
	});
	it('a stored empty array "[]" is honored as "log nothing", NOT reset to default', () => {
		expect(parseStackLogOperationsStorage('[]')).toEqual([]);
	});
	it('decodes and sanitizes a stored selection (drops unknown/dupes, canonical order)', () => {
		expect(parseStackLogOperationsStorage('["down","start","bogus","start","remove"]'))
			.toEqual(['start', 'down']);
	});
	it('malformed JSON falls back to the default instead of throwing', () => {
		expect(parseStackLogOperationsStorage('not json')).toEqual(DEFAULT_STACK_LOG_OPERATIONS);
		expect(parseStackLogOperationsStorage('{')).toEqual(DEFAULT_STACK_LOG_OPERATIONS);
	});
	it('a non-array JSON value (object/number) sanitizes to the default', () => {
		expect(parseStackLogOperationsStorage('{"a":1}')).toEqual(DEFAULT_STACK_LOG_OPERATIONS);
		expect(parseStackLogOperationsStorage('42')).toEqual(DEFAULT_STACK_LOG_OPERATIONS);
	});
});

describe('shouldShowStackLog', () => {
	it('shows only ops present in the list', () => {
		const ops: StackLogOperation[] = ['restart', 'deploy', 'down'];
		expect(shouldShowStackLog(ops, 'restart')).toBe(true);
		expect(shouldShowStackLog(ops, 'start')).toBe(false);
		expect(shouldShowStackLog(ops, 'stop')).toBe(false);
	});
	it('an empty list shows nothing', () => {
		expect(shouldShowStackLog([], 'deploy')).toBe(false);
	});
});
