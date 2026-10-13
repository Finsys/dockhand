/**
 * Pure demultiplexer for a Docker non-TTY exec/attach byte stream.
 *
 * Each frame is an 8-byte header (stream type in byte 0: 1=stdout, 2=stderr;
 * 32-bit big-endian payload size in bytes 4-7) followed by the payload. With
 * `separateStreams` the stdout and stderr payloads are returned apart; otherwise
 * they are concatenated (stdout first). No imports / no I/O so it is unit-testable.
 */
export function demuxDockerStream(
	buffer: Buffer,
	options?: { separateStreams?: boolean }
): string | { stdout: string; stderr: string } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	let offset = 0;

	while (offset < buffer.length) {
		if (offset + 8 > buffer.length) break;

		const streamType = buffer.readUInt8(offset);
		const frameSize = buffer.readUInt32BE(offset + 4);

		if (frameSize === 0 || frameSize > buffer.length - offset - 8) {
			// Invalid frame, return raw content with control chars stripped
			const raw = buffer.toString('utf-8').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
			return options?.separateStreams ? { stdout: raw, stderr: '' } : raw;
		}

		const payload = buffer.subarray(offset + 8, offset + 8 + frameSize).toString('utf-8');

		if (streamType === 1) {
			stdout.push(payload);
		} else if (streamType === 2) {
			stderr.push(payload);
		} else {
			stdout.push(payload); // Default to stdout for unknown types
		}

		offset += 8 + frameSize;
	}

	if (options?.separateStreams) {
		return { stdout: stdout.join(''), stderr: stderr.join('') };
	}
	return [...stdout, ...stderr].join('');
}
