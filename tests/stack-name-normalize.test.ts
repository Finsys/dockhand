import { describe, test, expect } from 'bun:test';
import { normalizeStackName } from '../src/lib/utils/stack-name';

describe('normalizeStackName', () => {
	test('lowercases uppercase names', () => {
		expect(normalizeStackName('Test')).toBe('test');
		expect(normalizeStackName('MyStack')).toBe('mystack');
		expect(normalizeStackName('ALLCAPS')).toBe('allcaps');
	});

	test('replaces invalid characters with hyphens', () => {
		expect(normalizeStackName('my stack')).toBe('my-stack');
		expect(normalizeStackName('my.stack.name')).toBe('my-stack-name');
		expect(normalizeStackName('stack@home!')).toBe('stack-home');
	});

	test('collapses multiple hyphens', () => {
		expect(normalizeStackName('my--stack')).toBe('my-stack');
		expect(normalizeStackName('a - b - c')).toBe('a-b-c');
	});

	test('trims leading and trailing hyphens', () => {
		expect(normalizeStackName('-stack-')).toBe('stack');
		expect(normalizeStackName('--stack--')).toBe('stack');
	});

	test('preserves underscores and digits', () => {
		expect(normalizeStackName('my_stack_2')).toBe('my_stack_2');
		expect(normalizeStackName('app123')).toBe('app123');
	});

	test('handles mixed cases from directory names', () => {
		expect(normalizeStackName('My Docker Stack')).toBe('my-docker-stack');
		expect(normalizeStackName('Production_App.v2')).toBe('production_app-v2');
	});
});
