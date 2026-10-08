/**
 * Unit tests for container sort order within stacks via dockhand.order label.
 *
 * Run with: bun test tests/unit/stack-order.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { compareContainerOrder } from '../src/lib/server/container-labels';

interface MockContainer {
	service: string;
	labels: Record<string, string>;
}

// The production comparator, not a copy of it: a local reimplementation would stay
// green against a broken one.
function sortContainers(containers: MockContainer[]): MockContainer[] {
	return [...containers].sort(compareContainerOrder);
}

describe('stack container sort order', () => {
	test('containers without labels sort alphabetically', () => {
		const containers: MockContainer[] = [
			{ service: 'redis', labels: {} },
			{ service: 'app', labels: {} },
			{ service: 'nginx', labels: {} },
		];
		const sorted = sortContainers(containers);
		expect(sorted.map(c => c.service)).toEqual(['app', 'nginx', 'redis']);
	});

	test('lower order values appear first', () => {
		const containers: MockContainer[] = [
			{ service: 'redis', labels: { 'dockhand.order': '3' } },
			{ service: 'app', labels: { 'dockhand.order': '1' } },
			{ service: 'nginx', labels: { 'dockhand.order': '2' } },
		];
		const sorted = sortContainers(containers);
		expect(sorted.map(c => c.service)).toEqual(['app', 'nginx', 'redis']);
	});

	test('same order value falls back to alphabetical', () => {
		const containers: MockContainer[] = [
			{ service: 'redis', labels: { 'dockhand.order': '1' } },
			{ service: 'app', labels: { 'dockhand.order': '1' } },
			{ service: 'nginx', labels: { 'dockhand.order': '1' } },
		];
		const sorted = sortContainers(containers);
		expect(sorted.map(c => c.service)).toEqual(['app', 'nginx', 'redis']);
	});

	test('negative values sort before default (0)', () => {
		const containers: MockContainer[] = [
			{ service: 'redis', labels: {} },
			{ service: 'app', labels: { 'dockhand.order': '-1' } },
			{ service: 'nginx', labels: {} },
		];
		const sorted = sortContainers(containers);
		expect(sorted.map(c => c.service)).toEqual(['app', 'nginx', 'redis']);
	});

	test('mixed labeled and unlabeled containers', () => {
		const containers: MockContainer[] = [
			{ service: 'redis', labels: {} },
			{ service: 'app', labels: { 'dockhand.order': '1' } },
			{ service: 'nginx', labels: { 'dockhand.order': '-1' } },
			{ service: 'postgres', labels: {} },
			{ service: 'worker', labels: { 'dockhand.order': '2' } },
		];
		const sorted = sortContainers(containers);
		// Every labelled container comes first, in its own order; the unlabelled ones
		// follow alphabetically.
		expect(sorted.map(c => c.service)).toEqual(['nginx', 'app', 'worker', 'postgres', 'redis']);
	});

	// Ordering ONE service is the common case: labelling it must be enough to move it
	// ahead of the rest, without labelling the whole stack or guessing a negative value.
	test('labelling a single service moves it to the front', () => {
		const containers: MockContainer[] = [
			{ service: 'db', labels: {} },
			{ service: 'forgejo', labels: { 'dockhand.order': '1' } }
		];
		expect(sortContainers(containers).map(c => c.service)).toEqual(['forgejo', 'db']);
	});

	// A stack that worked around this with negative values keeps the order it had.
	test('negative values still sort first', () => {
		const containers: MockContainer[] = [
			{ service: 'db', labels: {} },
			{ service: 'forgejo', labels: { 'dockhand.order': '-1' } }
		];
		expect(sortContainers(containers).map(c => c.service)).toEqual(['forgejo', 'db']);
	});

	test('an invalid order value sorts with the unlabelled containers', () => {
		const containers: MockContainer[] = [
			{ service: 'redis', labels: { 'dockhand.order': 'abc' } },
			{ service: 'app', labels: { 'dockhand.order': '1' } },
			{ service: 'nginx', labels: {} },
		];
		const sorted = sortContainers(containers);
		expect(sorted.map(c => c.service)).toEqual(['app', 'nginx', 'redis']);
	});
});
