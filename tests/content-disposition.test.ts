import { describe, test, expect } from 'bun:test';
import { attachmentContentDisposition } from '../src/lib/server/content-disposition';

/**
 * The download filename is derived from a user-influenced path, so it must never
 * land raw in the Content-Disposition header (quote breakout / CRLF injection).
 */
describe('attachmentContentDisposition', () => {
	test('always disposition=attachment with both filename and filename*', () => {
		const v = attachmentContentDisposition('config.yaml');
		expect(v.startsWith('attachment;')).toBe(true);
		expect(v).toContain('filename="config.yaml"');
		expect(v).toContain("filename*=UTF-8''config.yaml");
	});

	test('strips double-quote (no breakout of the quoted form)', () => {
		const v = attachmentContentDisposition('evil".pdf');
		// the fallback must not contain a bare quote that closes filename="
		expect(v).toContain('filename="evil.pdf"');
		// the encoded copy percent-encodes it instead
		expect(v).toContain('%22');
	});

	test('strips CR/LF so no header injection is possible', () => {
		const v = attachmentContentDisposition('a\r\nSet-Cookie: x=1');
		expect(v).not.toContain('\r');
		expect(v).not.toContain('\n');
		// CRLF is percent-encoded in the filename* copy
		expect(v).toContain('%0D%0A');
	});

	test('strips backslash', () => {
		const v = attachmentContentDisposition('back\\slash.log');
		expect(v).toContain('filename="backslash.log"');
	});

	test('handles non-ASCII via filename*', () => {
		const v = attachmentContentDisposition('résumé.txt');
		expect(v).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.txt");
	});

	test('empty / whitespace falls back to "download"', () => {
		expect(attachmentContentDisposition('')).toContain('filename="download"');
		expect(attachmentContentDisposition('   ')).toContain('filename="download"');
	});

	test('control characters are stripped from the fallback', () => {
		const v = attachmentContentDisposition('a\x00\x07\x1fb.txt');
		expect(v).toContain('filename="ab.txt"');
	});
});
