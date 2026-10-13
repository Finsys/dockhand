import { describe, test, expect } from 'bun:test';
import { containerMatchesSearch } from '../src/lib/utils/container-search-core';

const c = {
	name: 'my-nginx',
	image: 'nginx:1.27',
	labels: {
		'com.docker.compose.project': 'web',
		'heal': 'true',
		'traefik.enable': 'true',
		'maintainer': 'Alice',
	},
};

describe('containerMatchesSearch - free text', () => {
	test('empty query matches everything', () => {
		expect(containerMatchesSearch(c, '')).toBe(true);
		expect(containerMatchesSearch(c, '   ')).toBe(true);
	});
	test('matches name and image (existing behavior preserved)', () => {
		expect(containerMatchesSearch(c, 'nginx')).toBe(true);
		expect(containerMatchesSearch(c, '1.27')).toBe(true);
	});
	test('matches the compose project (existing behavior preserved)', () => {
		expect(containerMatchesSearch(c, 'web')).toBe(true);
	});
	test('NOW matches a label KEY as free text (the #1372 ask)', () => {
		expect(containerMatchesSearch(c, 'heal')).toBe(true);
		expect(containerMatchesSearch(c, 'traefik')).toBe(true);
	});
	test('matches a label VALUE as free text', () => {
		expect(containerMatchesSearch(c, 'alice')).toBe(true); // maintainer=Alice, case-insensitive
	});
	test('does not match an unrelated query', () => {
		expect(containerMatchesSearch(c, 'postgres')).toBe(false);
	});
});

describe('containerMatchesSearch - label: filter (docker ps --filter style)', () => {
	test('label:key matches a container that HAS the label (any value)', () => {
		expect(containerMatchesSearch(c, 'label:heal')).toBe(true);
		expect(containerMatchesSearch(c, 'label:maintainer')).toBe(true);
	});
	test('label:key is case-insensitive on the key', () => {
		expect(containerMatchesSearch(c, 'label:HEAL')).toBe(true);
	});
	test('label:key does NOT match when the label is absent', () => {
		expect(containerMatchesSearch(c, 'label:nope')).toBe(false);
	});
	test('label:key=value matches only when the value matches too', () => {
		expect(containerMatchesSearch(c, 'label:heal=true')).toBe(true);
		expect(containerMatchesSearch(c, 'label:heal=false')).toBe(false);
	});
	test('label:key=value is case-insensitive on the value', () => {
		expect(containerMatchesSearch(c, 'label:maintainer=alice')).toBe(true);
	});
	test('label: with a key that only partially matches does NOT match (exact key)', () => {
		// free-text "heal" matches; but label:hea should NOT (exact key semantics)
		expect(containerMatchesSearch(c, 'label:hea')).toBe(false);
	});
});

describe('containerMatchesSearch - no labels', () => {
	const bare = { name: 'x', image: 'busybox', labels: undefined };
	test('free text still works on name/image', () => {
		expect(containerMatchesSearch(bare, 'busybox')).toBe(true);
	});
	test('label: filter returns false when there are no labels', () => {
		expect(containerMatchesSearch(bare, 'label:heal')).toBe(false);
	});
});
