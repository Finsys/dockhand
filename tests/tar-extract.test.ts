import { describe, test, expect } from 'bun:test';
import { extractFirstFileFromTar } from '../src/lib/server/tar-extract';

// Hand-roll a minimal USTAR tar containing a single regular file.
// Mirrors the writer in docker.ts:writeContainerFile (which Dockhand already
// uses against Docker's archive API), so the parser is exercised against the
// exact format the production code emits.
function makeTar(filename: string, content: Uint8Array): Uint8Array {
	const fileSize = content.length;
	const paddedContentSize = Math.ceil(fileSize / 512) * 512;
	const totalSize = 512 + paddedContentSize + 1024;
	const tar = new Uint8Array(totalSize);
	const enc = new TextEncoder();

	tar.set(enc.encode(filename).slice(0, 100), 0);
	tar.set(enc.encode('0000644\0'), 100);
	tar.set(enc.encode('0000000\0'), 108);
	tar.set(enc.encode('0000000\0'), 116);
	tar.set(enc.encode(fileSize.toString(8).padStart(11, '0') + '\0'), 124);
	tar.set(enc.encode('0'.repeat(11) + '\0'), 136);
	tar.set(enc.encode('        '), 148); // checksum placeholder (spaces)
	tar[156] = 0x30; // typeflag '0' = regular file
	tar.set(enc.encode('ustar\0'), 257);
	tar.set(enc.encode('00'), 263);

	// Checksum: sum of first 512 bytes with checksum field treated as spaces
	let cs = 0;
	for (let i = 0; i < 512; i++) cs += tar[i];
	tar.set(enc.encode(cs.toString(8).padStart(6, '0') + '\0 '), 148);

	tar.set(content, 512);
	return tar;
}

describe('extractFirstFileFromTar', () => {
	test('returns the bytes of a single text file', () => {
		const content = new TextEncoder().encode('hello world\n');
		const tar = makeTar('greeting.txt', content);
		const out = extractFirstFileFromTar(tar);
		expect(new TextDecoder().decode(out)).toBe('hello world\n');
	});

	test('round-trips arbitrary binary bytes including NULs', () => {
		const content = new Uint8Array([0x00, 0xff, 0x42, 0x00, 0x01, 0x7f, 0x80]);
		const tar = makeTar('blob.bin', content);
		const out = extractFirstFileFromTar(tar);
		expect(Array.from(out)).toEqual(Array.from(content));
	});

	test('handles a file whose size is not a multiple of 512', () => {
		// 600 bytes — pads to 1024 in the tar but the extracted slice must be exactly 600
		const content = new Uint8Array(600).fill(0xab);
		const tar = makeTar('odd.bin', content);
		const out = extractFirstFileFromTar(tar);
		expect(out.length).toBe(600);
		expect(out.every((b) => b === 0xab)).toBe(true);
	});

	test('handles an empty file', () => {
		const tar = makeTar('empty.txt', new Uint8Array(0));
		const out = extractFirstFileFromTar(tar);
		expect(out.length).toBe(0);
	});

	test('throws when the tar contains no regular file', () => {
		// All-zero block looks like end-of-archive — no entries at all
		const tar = new Uint8Array(1024);
		expect(() => extractFirstFileFromTar(tar)).toThrow('No regular file');
	});

	test('throws on a truncated tar', () => {
		const content = new TextEncoder().encode('this content is missing');
		const tar = makeTar('truncated.txt', content);
		// Lop off the content — leave just the header
		const truncated = tar.slice(0, 512);
		expect(() => extractFirstFileFromTar(truncated)).toThrow();
	});
});
