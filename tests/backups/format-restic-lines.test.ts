/**
 * Unit tests for formatResticLines — turning raw restic (--json or plain) output
 * into human log lines for the backup/restore UI. No docker, no DB.
 */
import { describe, it, expect } from 'bun:test';
import { formatResticLines } from '../../src/lib/server/backups/backup-service';

describe('formatResticLines', () => {
	it('formats a --json status line to a percent (+ current file)', () => {
		const line = JSON.stringify({ message_type: 'status', percent_done: 0.42, current_files: ['/data/big.bin'] });
		expect(formatResticLines(line)).toEqual(['42% done — /data/big.bin']);
	});

	it('formats a status line with no current file', () => {
		const line = JSON.stringify({ message_type: 'status', percent_done: 1 });
		expect(formatResticLines(line)).toEqual(['100% done']);
	});

	it('formats a summary line', () => {
		const line = JSON.stringify({ message_type: 'summary', files_new: 3, files_changed: 1, files_unmodified: 10, data_added: 5_000_000 });
		expect(formatResticLines(line)).toEqual(['Done: 3 new, 1 changed, 10 unchanged · 5.0 MB added']);
	});

	it('formats an error line', () => {
		const line = JSON.stringify({ message_type: 'error', error: { message: 'permission denied' } });
		expect(formatResticLines(line)).toEqual(['error: permission denied']);
	});

	it('passes plain (non-JSON) restic/shell text through verbatim', () => {
		expect(formatResticLines('Fatal: unable to open config file')).toEqual(['Fatal: unable to open config file']);
	});

	it('passes JSON without message_type through verbatim', () => {
		expect(formatResticLines('{"foo":1}')).toEqual(['{"foo":1}']);
	});

	it('splits a multi-line chunk and drops blank lines', () => {
		const chunk = [
			JSON.stringify({ message_type: 'status', percent_done: 0.5 }),
			'',
			'plain line',
			'   ',
		].join('\n');
		expect(formatResticLines(chunk)).toEqual(['50% done', 'plain line']);
	});

	it('returns [] for empty/whitespace input', () => {
		expect(formatResticLines('')).toEqual([]);
		expect(formatResticLines('\n  \n')).toEqual([]);
	});
});
