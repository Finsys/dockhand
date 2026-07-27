/**
 * Format a byte count into a human-readable string.
 */
export function formatBytes(bytes: number, decimals = 1): string {
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : decimals)} ${units[i]}`;
}

/**
 * Compact byte format for grids: 1.2K, 500M, 2.1G
 */
export function formatBytesCompact(bytes: number, decimals = 1): string {
	if (bytes === 0) return '0B';
	const units = ['B', 'K', 'M', 'G', 'T'];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : decimals)}${units[i]}`;
}
