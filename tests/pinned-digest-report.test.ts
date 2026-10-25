import { describe, test, expect } from 'bun:test';
import { pinnedDigestReportEnabledFromSetting } from '../src/lib/utils/pinned-digest-report';

describe('pinnedDigestReportEnabledFromSetting (#1780 - default ON, only explicit false disables)', () => {
	test('absent/unset reports (default on, so #1755 behavior is kept on upgrade)', () => {
		expect(pinnedDigestReportEnabledFromSetting(undefined)).toBe(true);
		expect(pinnedDigestReportEnabledFromSetting(null)).toBe(true);
	});

	test('explicit true reports', () => {
		expect(pinnedDigestReportEnabledFromSetting(true)).toBe(true);
	});

	test('only an explicit false disables', () => {
		expect(pinnedDigestReportEnabledFromSetting(false)).toBe(false);
	});

	test('a non-boolean stored value does not disable (reports, unlike the opt-IN passkeys rule)', () => {
		// The near miss vs passkeysEnabledFromSetting (which is `=== true`): here a junk
		// value must NOT silence reports - only a deliberate false does.
		expect(pinnedDigestReportEnabledFromSetting('false')).toBe(true);
		expect(pinnedDigestReportEnabledFromSetting(0)).toBe(true);
	});
});
