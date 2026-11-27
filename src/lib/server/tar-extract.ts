/**
 * Single-file tar extraction for raw downloads (#1180).
 *
 * Docker's /archive endpoint always wraps file contents in a USTAR tar.
 * When the user picks the "no archive" download format and the path is a
 * regular file, we strip the wrapper and emit the bytes verbatim.
 *
 * Only handles the first regular-file entry — the caller has already
 * guaranteed (via stat) that the requested path is a single file, so the
 * tar contains exactly one entry.
 */

/**
 * Extract the bytes of the first regular file entry in a USTAR tar.
 * Returns the file content as a Uint8Array.
 *
 * Throws when no regular file entry is found (e.g. the tar contained only
 * a directory header) — that's an unexpected state, since the caller is
 * supposed to have already verified the path points to a file.
 */
export function extractFirstFileFromTar(tarData: Uint8Array): Uint8Array {
	let offset = 0;
	while (offset + 512 <= tarData.length) {
		const header = tarData.subarray(offset, offset + 512);

		// Two consecutive zero blocks mark end-of-archive.
		if (isZeroBlock(header)) break;

		const name = readString(header, 0, 100);
		const sizeOctal = readString(header, 124, 12).trim();
		const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
		// The archive comes from a daemon: a negative size would keep the walk on the same
		// header forever, so refuse it, and an unreadable one with it.
		if (!Number.isFinite(size) || size < 0) throw new Error('Invalid tar header size');
		const typeFlag = header[156];

		// Regular file: typeflag '0' (0x30) or NUL (0x00, legacy)
		const isRegularFile = typeFlag === 0x30 || typeFlag === 0x00;

		if (isRegularFile && name && size >= 0) {
			const start = offset + 512;
			const end = start + size;
			if (end > tarData.length) {
				throw new Error('Truncated tar archive');
			}
			return tarData.subarray(start, end);
		}

		// Skip header + content (padded to 512-byte boundary)
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	throw new Error('No regular file entry found in tar archive');
}

function isZeroBlock(block: Uint8Array): boolean {
	for (let i = 0; i < block.length; i++) {
		if (block[i] !== 0) return false;
	}
	return true;
}

function readString(buf: Uint8Array, offset: number, length: number): string {
	let end = offset;
	const limit = offset + length;
	while (end < limit && buf[end] !== 0) end++;
	return new TextDecoder('utf-8').decode(buf.subarray(offset, end));
}
