import { describe, it, expect } from 'bun:test';
import { updaterImageForVariant } from '../src/lib/server/updater-image-core';

describe('updaterImageForVariant', () => {
	it('uses the -baseline updater for the baseline Dockhand variant (old x86_64 without v2)', () => {
		expect(updaterImageForVariant('baseline')).toBe('fnsys/dockhand-updater:latest-baseline');
	});

	it('uses the default updater for the normal (Wolfi) variant', () => {
		expect(updaterImageForVariant(undefined)).toBe('fnsys/dockhand-updater:latest');
		expect(updaterImageForVariant('')).toBe('fnsys/dockhand-updater:latest');
	});

	it('only the exact "baseline" value switches variant (no accidental match)', () => {
		expect(updaterImageForVariant('Baseline')).toBe('fnsys/dockhand-updater:latest');
		expect(updaterImageForVariant('baseline-x')).toBe('fnsys/dockhand-updater:latest');
	});
});
