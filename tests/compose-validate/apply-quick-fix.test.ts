// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import { applyQuickFix } from '../../src/lib/utils/compose-quick-fix';

describe('applyQuickFix', () => {
	test('delete-line removes exactly that 1-based line', () => {
		const src = `version: "3.8"\nservices:\n  web:\n    image: nginx:1.27\n`;
		expect(applyQuickFix(src, { kind: 'delete-line', line: 1 })).toBe(
			`services:\n  web:\n    image: nginx:1.27\n`
		);
	});

	test('replace-in-line swaps the first occurrence, keeping indentation', () => {
		const src = `services:\n  web:\n    image: nginx:1.27\n    restar: always\n`;
		expect(applyQuickFix(src, { kind: 'replace-in-line', line: 4, find: 'restar', replace: 'restart' })).toBe(
			`services:\n  web:\n    image: nginx:1.27\n    restart: always\n`
		);
	});

	test('replace-in-line prefixes a port binding without touching quotes', () => {
		const src = `services:\n  db:\n    ports:\n      - "5432:5432"\n`;
		expect(
			applyQuickFix(src, { kind: 'replace-in-line', line: 4, find: '5432:5432', replace: '127.0.0.1:5432:5432' })
		).toBe(`services:\n  db:\n    ports:\n      - "127.0.0.1:5432:5432"\n`);
	});

	test('a fix whose text no longer matches leaves the source unchanged (stale)', () => {
		const src = `services:\n  web:\n    image: nginx:1.27\n`;
		expect(applyQuickFix(src, { kind: 'replace-in-line', line: 3, find: 'gone', replace: 'x' })).toBe(src);
	});

	test('an out-of-range line leaves the source unchanged', () => {
		const src = `services:\n  web:\n    image: nginx:1.27\n`;
		expect(applyQuickFix(src, { kind: 'delete-line', line: 99 })).toBe(src);
	});

	test('insert-after adds the text as the next line, verbatim (indent in text)', () => {
		const src = `services:\n  web:\n    image: nginx:1.27\n`;
		expect(applyQuickFix(src, { kind: 'insert-after', line: 2, text: '    restart: unless-stopped' })).toBe(
			`services:\n  web:\n    restart: unless-stopped\n    image: nginx:1.27\n`
		);
	});

	test('CRLF line endings on other lines are preserved', () => {
		const src = `version: "3.8"\r\nservices:\r\n  web:\r\n    image: nginx:1.27\r\n`;
		// delete the version line; the remaining \r stay intact.
		expect(applyQuickFix(src, { kind: 'delete-line', line: 1 })).toBe(
			`services:\r\n  web:\r\n    image: nginx:1.27\r\n`
		);
	});
});

describe('replace-in-line anchoring (review regression)', () => {
	test("`at` anchors to the intended occurrence, not the first substring", () => {
		// The short "80:80" token is a substring of the earlier "8080:80" token.
		const line = '    ports: ["8080:80", "80:80"]';
		const src = `services:\n  db:\n${line}\n`;
		const at = line.indexOf('"80:80"') + 1; // column of the 2nd token
		const out = applyQuickFix(src, { kind: 'replace-in-line', line: 3, find: '80:80', replace: '127.0.0.1:80:80', at });
		expect(out).toContain('"8080:80"'); // earlier token intact
		expect(out).toContain('"127.0.0.1:80:80"'); // correct token rewritten
		expect(out).not.toContain('80127.0.0.1'); // no corruption
	});
	test('without `at`, falls back to first occurrence (unchanged behavior)', () => {
		const src = `services:\n  a:\n    restar: always\n`;
		const out = applyQuickFix(src, { kind: 'replace-in-line', line: 3, find: 'restar', replace: 'restart' });
		expect(out).toContain('restart: always');
	});
});
