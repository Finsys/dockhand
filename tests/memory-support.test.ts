import { describe, it, expect } from 'bun:test';
import { memorySupportFromInfo, MEMORY_SUPPORT_DOC_URL } from '../src/lib/utils/memory-support';

describe('memorySupportFromInfo', () => {
	it('warns when MemoryLimit is false (cgroup memory off - Raspberry Pi case)', () => {
		const r = memorySupportFromInfo({ MemoryLimit: false, SwapLimit: false });
		expect(r.warn).toBe(true);
		expect(r.memoryLimitSupported).toBe(false);
	});

	it('does not warn when MemoryLimit is true', () => {
		const r = memorySupportFromInfo({ MemoryLimit: true, SwapLimit: true });
		expect(r.warn).toBe(false);
		expect(r.memoryLimitSupported).toBe(true);
	});

	it('treats a missing MemoryLimit as supported (no false alarm on older/partial info)', () => {
		expect(memorySupportFromInfo({}).warn).toBe(false);
		expect(memorySupportFromInfo(null).warn).toBe(false);
		expect(memorySupportFromInfo(undefined).warn).toBe(false);
	});

	it('swap-only off does not warn (memory is what drives the 0 B display)', () => {
		const r = memorySupportFromInfo({ MemoryLimit: true, SwapLimit: false });
		expect(r.warn).toBe(false);
		expect(r.swapLimitSupported).toBe(false);
	});

	it('does NOT warn on a Windows daemon even though MemoryLimit is false (#1574)', () => {
		// Windows reports MemoryLimit:false but per-container memory works fine, so the
		// Linux cgroup-accounting warning is wrong there.
		const r = memorySupportFromInfo({ MemoryLimit: false, SwapLimit: false, OSType: 'windows' });
		expect(r.warn).toBe(false);
		expect(r.memoryLimitSupported).toBe(false); // still reflects the raw flag
	});

	it('still warns on a Linux daemon with MemoryLimit false (RPi case unchanged)', () => {
		expect(memorySupportFromInfo({ MemoryLimit: false, OSType: 'linux' }).warn).toBe(true);
	});

	it('doc url points at the manual anchor', () => {
		expect(MEMORY_SUPPORT_DOC_URL).toBe('https://dockhand.pro/manual/#troubleshooting-rpi-memory');
	});
});
