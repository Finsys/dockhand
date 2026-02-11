/**
 * Crypto Fallback for Old Linux Kernels
 *
 * The getrandom() syscall was added in Linux 3.17. On older kernels (like 3.10.x),
 * Bun's built-in crypto functions will fail with "getrandom() failed to provide entropy".
 *
 * This module provides fallback implementations that read from /dev/urandom directly
 * when running on kernels older than 3.17.
 */

import { existsSync, openSync, readSync, closeSync } from 'node:fs';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

// Cache kernel version check result
let needsFallback: boolean | null = null;
let fallbackInitialized = false;

/**
 * Parse Linux kernel version string (e.g., "3.10.108" -> { major: 3, minor: 10, patch: 108 })
 */
function parseKernelVersion(release: string): { major: number; minor: number; patch: number } | null {
	const match = release.match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!match) return null;
	return {
		major: parseInt(match[1], 10),
		minor: parseInt(match[2], 10),
		patch: parseInt(match[3], 10)
	};
}

/**
 * Check if kernel version is older than 3.17 (when getrandom() was added)
 */
function isOldKernel(): boolean {
	const release = os.release();
	const version = parseKernelVersion(release);

	if (!version) {
		// Can't parse version, assume modern kernel
		return false;
	}

	// getrandom() was added in Linux 3.17
	if (version.major < 3) return true;
	if (version.major === 3 && version.minor < 17) return true;

	return false;
}

/**
 * Check if we're on Linux (only Linux has kernel version concerns)
 */
function isLinux(): boolean {
	return os.platform() === 'linux';
}

/**
 * Determine if we need to use the fallback (cached)
 */
function checkNeedsFallback(): boolean {
	if (needsFallback !== null) return needsFallback;

	if (!isLinux()) {
		needsFallback = false;
		return false;
	}

	const oldKernel = isOldKernel();
	if (oldKernel) {
		console.log(`[Crypto] Detected old Linux kernel (${os.release()}), using /dev/urandom fallback`);
		needsFallback = true;
	} else {
		needsFallback = false;
	}

	return needsFallback;
}

/**
 * Read random bytes from /dev/urandom (synchronous)
 */
function readFromUrandom(size: number): Buffer {
	const buffer = Buffer.alloc(size);
	const fd = openSync('/dev/urandom', 'r');
	try {
		readSync(fd, buffer, 0, size, null);
	} finally {
		closeSync(fd);
	}
	return buffer;
}

/**
 * Initialize the crypto fallback - call this early at startup
 * Returns true if fallback is needed, false otherwise
 */
export function initCryptoFallback(): boolean {
	if (fallbackInitialized) return needsFallback ?? false;

	const release = os.release();
	const platform = os.platform();
	const useFallback = checkNeedsFallback();

	if (useFallback) {
		console.log(`[Crypto] Kernel: ${release} (old kernel detected, using /dev/urandom fallback)`);

		// Verify /dev/urandom exists
		if (!existsSync('/dev/urandom')) {
			console.error('[Crypto] FATAL: /dev/urandom not found, cannot provide entropy');
			throw new Error('/dev/urandom not available');
		}

		// Test that we can read from it
		try {
			const testBytes = readFromUrandom(8);
			if (testBytes.length !== 8) {
				throw new Error('Failed to read expected bytes');
			}
			console.log('[Crypto] /dev/urandom fallback initialized successfully');
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			console.error('[Crypto] FATAL: Failed to read from /dev/urandom:', errorMsg);
			throw err;
		}
	} else {
		console.log(`[Crypto] Kernel: ${platform === 'linux' ? release : platform} (using native crypto)`);
	}

	fallbackInitialized = true;
	return useFallback;
}

/**
 * Generate cryptographically secure random bytes
 * Uses /dev/urandom on old kernels, native crypto otherwise
 */
export function secureRandomBytes(size: number): Buffer {
	if (checkNeedsFallback()) {
		return readFromUrandom(size);
	}

	// Use native crypto on modern kernels
	return randomBytes(size);
}

/**
 * Fill a Uint8Array with cryptographically secure random values
 * Compatible with crypto.getRandomValues() API
 */
export function secureGetRandomValues<T extends ArrayBufferView>(array: T): T {
	if (checkNeedsFallback()) {
		const bytes = readFromUrandom(array.byteLength);
		const target = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
		target.set(bytes);
		return array;
	}

	// Use native crypto on modern kernels
	return crypto.getRandomValues(array);
}

/**
 * Generate a random UUID (v4)
 * Compatible with crypto.randomUUID() API
 */
export function secureRandomUUID(): string {
	if (checkNeedsFallback()) {
		// Generate 16 random bytes
		const bytes = readFromUrandom(16);

		// Set version (4) and variant (RFC 4122)
		bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
		bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant 10

		// Convert to UUID string
		const hex = bytes.toString('hex');
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
	}

	// Use native crypto on modern kernels
	return crypto.randomUUID();
}

/**
 * Check if running on an old kernel that needs the fallback
 */
export function usingFallback(): boolean {
	return checkNeedsFallback();
}

/**
 * Get kernel version info (useful for diagnostics)
 */
export function getKernelInfo(): { release: string; needsFallback: boolean } {
	return {
		release: os.release(),
		needsFallback: checkNeedsFallback()
	};
}
