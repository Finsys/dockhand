import { describe, expect, test } from 'bun:test';
import { downloadFileName, stripAnsi } from '../src/lib/utils/log-download-name';

describe('downloadFileName', () => {
	test('uses the title when one is given', () => {
		expect(downloadFileName('web-1')).toBe('web-1-logs.txt');
	});

	test('falls back to a neutral name when no title is given', () => {
		expect(downloadFileName(undefined)).toBe('logs.txt');
	});

	test('strips path separators so a title can never escape the download name', () => {
		expect(downloadFileName('../../etc/passwd')).toBe('etcpasswd-logs.txt');
		expect(downloadFileName('..\\..\\windows\\system32')).toBe('windowssystem32-logs.txt');
	});

	// One case per transformation -- otherwise removing .trim() leaves every test green.
	test('trims surrounding whitespace', () => {
		expect(downloadFileName('  web-1  ')).toBe('web-1-logs.txt');
	});
});

describe('stripAnsi', () => {
	test('removes ANSI escape sequences', () => {
		expect(stripAnsi('\u001b[32mok\u001b[0m')).toBe('ok');
	});

	// docker compose hides and shows the cursor on every progress redraw. '?' is a CSI
	// parameter byte, so a digits-and-semicolons pattern leaves these behind -- in exactly
	// the output this viewer is built to show.
	test('removes private-mode sequences, which is what compose emits', () => {
		expect(stripAnsi('\u001b[?25lbuilding\u001b[?25h')).toBe('building');
		expect(stripAnsi('\u001b[?2004hx')).toBe('x');
	});

	test('leaves text without escape sequences untouched', () => {
		expect(stripAnsi('Container web-1  Started')).toBe('Container web-1  Started');
	});
});
