/**
 * Whether the daemon's kernel supports per-container memory accounting, read from
 * Docker `/info`. When the cgroup memory controller is disabled in the kernel boot
 * config (common on Raspberry Pi and some ARM boards), the daemon reports
 * `MemoryLimit: false` and every container's memory usage shows as 0. Docker itself
 * detects this - we surface it so the user isn't left guessing why memory is blank.
 */

export interface MemorySupportInfo {
	/** true = the UI can show a warning that memory accounting is off. */
	warn: boolean;
	/** Docker's own `/info.MemoryLimit`. */
	memoryLimitSupported: boolean;
	/** Docker's own `/info.SwapLimit`. */
	swapLimitSupported: boolean;
}

/**
 * Derive the memory-support flags from a Docker `/info` response. `MemoryLimit`/
 * `SwapLimit` are booleans; a missing/undefined field is treated as SUPPORTED (no
 * warning) so an older daemon or a partial info payload never produces a false alarm.
 */
export function memorySupportFromInfo(info: { MemoryLimit?: boolean; SwapLimit?: boolean } | null | undefined): MemorySupportInfo {
	const memoryLimitSupported = info?.MemoryLimit !== false;
	const swapLimitSupported = info?.SwapLimit !== false;
	return { warn: !memoryLimitSupported, memoryLimitSupported, swapLimitSupported };
}

/** Link to the manual section explaining how to enable cgroup memory accounting. */
export const MEMORY_SUPPORT_DOC_URL = 'https://dockhand.pro/manual/#troubleshooting-rpi-memory';
