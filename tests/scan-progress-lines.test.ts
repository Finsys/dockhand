/**
 * Scan console lines (#1629): a scanner output line must not repeat the
 * status-bar message next to it.
 */
import { describe, it, expect } from 'bun:test';
import { scanProgressLines } from '../src/lib/utils/scan-progress-lines';

describe('scanProgressLines', () => {
	it('logs only the output when an event carries output and message', () => {
		expect(
			scanProgressLines({ scanner: 'grype', message: 'Scanning nginx with Grype...', output: 'Loading DB' })
		).toEqual(['[grype] Loading DB']);
	});

	it('logs the message when there is no output', () => {
		expect(scanProgressLines({ scanner: 'trivy', message: 'Starting Trivy scan...' })).toEqual([
			'[trivy] Starting Trivy scan...'
		]);
	});

	it('falls back to the dockhand prefix without a scanner', () => {
		expect(scanProgressLines({ message: 'Starting scan...' })).toEqual(['[dockhand] Starting scan...']);
	});

	it('logs nothing for an event with neither field', () => {
		expect(scanProgressLines({ scanner: 'grype' })).toEqual([]);
	});

	it('does not duplicate the status message across a stream of output lines', () => {
		const events = [
			{ scanner: 'grype', message: 'Starting Grype scan...' },
			{ scanner: 'grype', message: 'Scanning nginx with Grype...', output: 'line 1' },
			{ scanner: 'grype', message: 'Scanning nginx with Grype...', output: 'line 2' }
		];
		expect(events.flatMap(scanProgressLines)).toEqual([
			'[grype] Starting Grype scan...',
			'[grype] line 1',
			'[grype] line 2'
		]);
	});
});
