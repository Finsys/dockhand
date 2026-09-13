/**
 * nextIoSortState: a two-metric grid column (Disk I/O = read/write) cycles a header
 * click through all four (metric, direction) states rather than a plain asc/desc
 * toggle (#1111).
 */
import { describe, it, expect } from 'bun:test';
import { nextIoSortState } from '../src/lib/utils/io-sort-cycle';

const DISK = [
	{ field: 'diskRead', direction: 'desc' as const },
	{ field: 'diskRead', direction: 'asc' as const },
	{ field: 'diskWrite', direction: 'desc' as const },
	{ field: 'diskWrite', direction: 'asc' as const }
];

describe('nextIoSortState', () => {
	it('starts the cycle at read-desc when the column is not currently sorted', () => {
		expect(nextIoSortState(DISK, { field: 'name', direction: 'asc' })).toEqual(DISK[0]);
	});

	it('walks read-desc -> read-asc -> write-desc -> write-asc', () => {
		expect(nextIoSortState(DISK, DISK[0])).toEqual(DISK[1]);
		expect(nextIoSortState(DISK, DISK[1])).toEqual(DISK[2]);
		expect(nextIoSortState(DISK, DISK[2])).toEqual(DISK[3]);
	});

	it('wraps from the last state back to the first', () => {
		expect(nextIoSortState(DISK, DISK[3])).toEqual(DISK[0]);
	});

	it('restarts the cycle when the current field is another cycle column', () => {
		// e.g. the user was sorting Net I/O, now clicks Disk I/O
		expect(nextIoSortState(DISK, { field: 'netRx', direction: 'asc' })).toEqual(DISK[0]);
	});
});
