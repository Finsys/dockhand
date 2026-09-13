/**
 * Unit tests for container sort order within stacks via dockhand.order label.
 *
 * Run with: bun test tests/unit/stack-order.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { getOrderValue } from '../src/lib/server/container-labels';

interface MockContainer {
	service: string;
	labels: Record<string, string>;
}

function sortContainers(containers: MockContainer[]): MockContainer[] {
	return [...containers].sort((a, b) => {
		const orderA = getOrderValue(a.labels);
		const orderB = getOrderValue(b.labels);
		if (orderA !== orderB) return orderA - orderB;
		return a.service.localeCompare(b.service);
	});
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
		// nginx(-1) → postgres(0) → redis(0) → app(1) → worker(2)
		expect(sorted.map(c => c.service)).toEqual(['nginx', 'postgres', 'redis', 'app', 'worker']);
	});

	test('invalid order values treated as 0', () => {
		const containers: MockContainer[] = [
			{ service: 'redis', labels: { 'dockhand.order': 'abc' } },
			{ service: 'app', labels: { 'dockhand.order': '1' } },
			{ service: 'nginx', labels: {} },
		];
		const sorted = sortContainers(containers);
		// nginx(0) → redis(0, invalid=0) → app(1)
		expect(sorted.map(c => c.service)).toEqual(['nginx', 'redis', 'app']);
	});
});
