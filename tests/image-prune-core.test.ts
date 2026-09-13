// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect } from 'bun:test';
import { buildImagePruneFilters, PRUNE_KEEP_LABEL } from '../src/lib/server/image-prune-core';

function decode(filters: string): Record<string, string[]> {
	return JSON.parse(decodeURIComponent(filters));
}

describe('buildImagePruneFilters', () => {
	test('dangling=true has no label filter (untagged images have no keep label)', () => {
		expect(decode(buildImagePruneFilters(true))).toEqual({ dangling: ['true'] });
	});

	test('dangling=false excludes keep-labelled images via the label! key', () => {
		// The negation MUST be the separate `label!` key, not a `!=` value prefix -
		// the API ignores the `!=` form (verified against a live daemon).
		expect(decode(buildImagePruneFilters(false))).toEqual({
			dangling: ['false'],
			'label!': ['dockhand.prune=false']
		});
	});

	test('does NOT use a plain "label" key (which would invert the meaning)', () => {
		const f = decode(buildImagePruneFilters(false));
		expect(f['label']).toBeUndefined();
		expect(f['label!']).toEqual([PRUNE_KEEP_LABEL]);
	});

	test('the produced value is URL-encoded', () => {
		expect(buildImagePruneFilters(false)).not.toContain('{');
		expect(buildImagePruneFilters(false)).toContain('%7B');
	});
});
