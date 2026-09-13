/**
 * Unit tests for the pure volume-prune selector. No Docker, no db — drives the
 * selection logic directly so the "unused & not protected" rule and, critically,
 * the scanner-cache protection can never silently regress.
 */
import { describe, it, expect } from 'bun:test';
import {
	selectVolumesToPrune,
	PROTECTED_VOLUME_NAMES,
} from '../src/lib/server/volume-prune-core';

const unused = (name: string) => ({ name, usedBy: [] as unknown[] });
const inUse = (name: string) => ({ name, usedBy: [{ containerId: 'c1', containerName: 'x' }] });

describe('selectVolumesToPrune', () => {
	it('selects an unused, unprotected volume', () => {
		expect(selectVolumesToPrune([unused('data-1')])).toEqual(['data-1']);
	});

	it('does NOT select a volume in use (usedBy non-empty)', () => {
		expect(selectVolumesToPrune([inUse('data-1')])).toEqual([]);
	});

	it('does NOT select the grype scanner cache even when unused', () => {
		expect(selectVolumesToPrune([unused('dockhand-grype-db')])).toEqual([]);
	});

	it('does NOT select the trivy scanner cache even when unused', () => {
		expect(selectVolumesToPrune([unused('dockhand-trivy-db')])).toEqual([]);
	});

	it('returns exactly the unused-and-unprotected names from a mixed list', () => {
		const result = selectVolumesToPrune([
			unused('dangling-a'),
			inUse('live-b'),
			unused('dockhand-grype-db'),
			unused('dockhand-trivy-db'),
			unused('dangling-c'),
			inUse('live-d'),
		]);
		expect(result.sort()).toEqual(['dangling-a', 'dangling-c']);
	});

	it('returns [] for empty / all-protected / all-in-use inputs', () => {
		expect(selectVolumesToPrune([])).toEqual([]);
		expect(selectVolumesToPrune([unused('dockhand-grype-db'), unused('dockhand-trivy-db')])).toEqual([]);
		expect(selectVolumesToPrune([inUse('a'), inUse('b')])).toEqual([]);
	});

	it('protects exactly the two scanner cache volumes and nothing else', () => {
		// Guard against the protected set drifting to include/exclude the wrong names.
		expect([...PROTECTED_VOLUME_NAMES].sort()).toEqual(['dockhand-grype-db', 'dockhand-trivy-db']);
	});

	it('honors a custom protected list argument', () => {
		expect(selectVolumesToPrune([unused('keep-me'), unused('drop-me')], ['keep-me'])).toEqual(['drop-me']);
	});
});
