import { describe, expect, test } from 'bun:test';
import { getStreamingControlState } from '../src/lib/utils/log-streaming-state';

describe('getStreamingControlState', () => {
	test('returns active state when streaming is enabled (dark mode)', () => {
		const state = getStreamingControlState(true, true);
		expect(state.isStreaming).toBe(true);
		expect(state.action).toBe('pause');
		expect(state.buttonClass).toContain('bg-amber-500/20');
		expect(state.buttonClass).toContain('text-amber-400');
	});

	test('returns active state when streaming is enabled (light mode)', () => {
		const state = getStreamingControlState(true, false);
		expect(state.isStreaming).toBe(true);
		expect(state.action).toBe('pause');
		expect(state.buttonClass).toContain('bg-amber-500/30');
		expect(state.buttonClass).toContain('text-amber-700');
	});

	test('returns inactive state when streaming is disabled (dark mode)', () => {
		const state = getStreamingControlState(false, true);
		expect(state.isStreaming).toBe(false);
		expect(state.action).toBe('resume');
		expect(state.buttonClass).toContain('text-zinc-500');
	});

	test('returns inactive state when streaming is disabled (light mode)', () => {
		const state = getStreamingControlState(false, false);
		expect(state.isStreaming).toBe(false);
		expect(state.action).toBe('resume');
		expect(state.buttonClass).toContain('text-gray-500');
	});
});
