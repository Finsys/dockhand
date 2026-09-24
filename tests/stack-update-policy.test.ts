import { describe, expect, test } from 'bun:test';
import {
	parseStackUpdatePolicy,
	planStackUpdate,
	isDefaultStackUpdatePlan,
	normalizeImageRef,
	resolveServicePolicy,
	serviceHasBuildContext,
	defaultStackUpdatePolicy
} from '../src/lib/server/stack-update-policy';

const BASE = `
x-dockhand:
  update:
    mode: rebuild
    cascade: same-image
    no-cache: true
    exclude: [db, redis]
services:
  app:
    build: .
    image: ghcr.io/me/app:latest
  worker:
    build: ./worker
    image: ghcr.io/me/app:latest
  db:
    image: postgres:16
  redis:
    image: redis:7
`;

describe('parseStackUpdatePolicy', () => {
	test('no x-dockhand block -> back-compat defaults', () => {
		const p = parseStackUpdatePolicy('services:\n  app:\n    image: nginx\n');
		expect(p.stack).toEqual(defaultStackUpdatePolicy());
		expect(p.unparseable).toBe(false);
		expect(p.services.map((s) => s.name)).toEqual(['app']);
	});

	test('invalid YAML -> defaults, unparseable, never throws', () => {
		const p = parseStackUpdatePolicy('services:\n  app:\n    build: [unterminated');
		expect(p.unparseable).toBe(true);
		expect(p.stack).toEqual(defaultStackUpdatePolicy());
		expect(p.services).toEqual([]);
	});

	test('empty content -> defaults', () => {
		expect(parseStackUpdatePolicy('').stack).toEqual(defaultStackUpdatePolicy());
	});

	test('reads the top-level block (mode, cascade, no-cache, exclude)', () => {
		const p = parseStackUpdatePolicy(BASE);
		expect(p.stack).toEqual({
			mode: 'rebuild',
			cascade: 'same-image',
			noCache: true,
			exclude: ['db', 'redis']
		});
	});

	test('accepts camelCase noCache and cascade: false as a boolean', () => {
		const p = parseStackUpdatePolicy(
			'x-dockhand:\n  update:\n    cascade: false\n    noCache: true\nservices:\n  app:\n    image: nginx\n'
		);
		expect(p.stack.cascade).toBe('false');
		expect(p.stack.noCache).toBe(true);
	});

	test('unknown/invalid values degrade to the default, not a crash', () => {
		const p = parseStackUpdatePolicy(
			'x-dockhand:\n  update:\n    mode: explode\n    cascade: sideways\n    no-cache: maybe\nservices:\n  app:\n    image: nginx\n'
		);
		expect(p.stack).toEqual(defaultStackUpdatePolicy());
	});

	test('detects build: (string and object) per service', () => {
		const p = parseStackUpdatePolicy(
			'services:\n  a:\n    build: ./a\n  b:\n    build:\n      context: .\n      dockerfile_inline: FROM x\n  c:\n    image: nginx\n'
		);
		expect(serviceHasBuildContext(p, 'a')).toBe(true);
		expect(serviceHasBuildContext(p, 'b')).toBe(true);
		expect(serviceHasBuildContext(p, 'c')).toBe(false);
		expect(p.services.find((s) => s.name === 'c')?.hasBuild).toBe(false);
	});

	test('captures a per-service override', () => {
		const p = parseStackUpdatePolicy(
			'x-dockhand:\n  update:\n    mode: recreate\nservices:\n  worker:\n    image: app\n    x-dockhand:\n      update:\n        mode: rebuild\n'
		);
		expect(resolveServicePolicy(p, 'worker').mode).toBe('rebuild');
		expect(resolveServicePolicy(p, 'other').mode).toBe('recreate');
	});
});

describe('normalizeImageRef', () => {
	test('treats implicit and explicit latest the same', () => {
		expect(normalizeImageRef('nginx')).toBe(normalizeImageRef('nginx:latest'));
	});

	test('strips the default registry and library namespace', () => {
		expect(normalizeImageRef('docker.io/library/nginx:1.25')).toBe(normalizeImageRef('nginx:1.25'));
	});

	test('drops the digest', () => {
		expect(normalizeImageRef('app@sha256:abc')).toBe(normalizeImageRef('app:latest'));
	});

	test('keeps a real tag and a non-default registry host', () => {
		expect(normalizeImageRef('ghcr.io/me/app:1.2')).not.toBe(normalizeImageRef('ghcr.io/me/app:1.3'));
		expect(normalizeImageRef('ghcr.io/me/app:1.2')).toBe('ghcr.io/me/app:1.2');
	});
});

describe('planStackUpdate', () => {
	test('no policy -> default single-service plan (back-compat)', () => {
		const parsed = parseStackUpdatePolicy('services:\n  app:\n    image: nginx\n');
		const plan = planStackUpdate(parsed, 'app', 'nginx');
		expect(isDefaultStackUpdatePlan(plan)).toBe(true);
		expect(plan.mode).toBe('recreate');
		expect(plan.targets).toEqual(['app']);
		expect(plan.wholeStack).toBe(false);
	});

	test('cascade: same-image redeploys services sharing the changed image', () => {
		const parsed = parseStackUpdatePolicy(BASE);
		const plan = planStackUpdate(parsed, 'app', 'ghcr.io/me/app:latest');
		expect(plan.targets).toEqual(['app', 'worker']);
		expect(plan.mode).toBe('rebuild');
		expect(plan.noCache).toBe(true);
	});

	test('cascade: all redeploys the whole stack minus exclude', () => {
		const parsed = parseStackUpdatePolicy(
			'x-dockhand:\n  update:\n    cascade: all\n    exclude: [db]\nservices:\n  app:\n    image: a\n  worker:\n    image: b\n  db:\n    image: postgres\n'
		);
		const plan = planStackUpdate(parsed, 'app', 'a');
		expect(plan.targets).toEqual(['app', 'worker']);
		expect(plan.excludedServices).toEqual(['db']);
		expect(plan.skipped).toEqual([{ service: 'db', reason: 'excluded' }]);
	});

	test('exclude always wins, but the changed service is never dropped from its own update', () => {
		const parsed = parseStackUpdatePolicy(
			'x-dockhand:\n  update:\n    cascade: all\n    exclude: [app]\nservices:\n  app:\n    image: a\n  other:\n    image: b\n'
		);
		const plan = planStackUpdate(parsed, 'app', 'a');
		expect(plan.targets).toEqual(['app', 'other']);
	});

	test('mode: rebuild alone means whole stack', () => {
		const parsed = parseStackUpdatePolicy(
			'x-dockhand:\n  update:\n    mode: rebuild\nservices:\n  app:\n    build: .\n  sidecar:\n    build: ./s\n'
		);
		const plan = planStackUpdate(parsed, 'app', 'app');
		expect(plan.wholeStack).toBe(true);
		expect(plan.targets).toEqual(['app', 'sidecar']);
	});

	test('mode: build scopes to the changed service unless a cascade is set', () => {
		const parsed = parseStackUpdatePolicy(
			'x-dockhand:\n  update:\n    mode: build\nservices:\n  app:\n    build: .\n  worker:\n    build: ./w\n'
		);
		const plan = planStackUpdate(parsed, 'app', 'app');
		expect(plan.mode).toBe('build');
		expect(plan.targets).toEqual(['app']);
		expect(plan.wholeStack).toBe(false);
	});

	test('per-service override beats the stack default', () => {
		const parsed = parseStackUpdatePolicy(
			'x-dockhand:\n  update:\n    mode: recreate\nservices:\n  worker:\n    image: app\n    x-dockhand:\n      update:\n        mode: rebuild\n  app:\n    image: app\n'
		);
		expect(planStackUpdate(parsed, 'worker', 'app').mode).toBe('rebuild');
		expect(planStackUpdate(parsed, 'app', 'app').mode).toBe('recreate');
	});

	test('same-image cascade does not match an interpolated image against the resolved running image', () => {
		// The compose value is the raw `${TAG}`; the changed container reports its
		// RESOLVED image. They can never be proven equal, so no optimistic cascade.
		const parsed = parseStackUpdatePolicy(
			'x-dockhand:\n  update:\n    cascade: same-image\nservices:\n  app:\n    image: ${TAG}\n  other:\n    image: ${TAG}\n'
		);
		const plan = planStackUpdate(parsed, 'app', 'ghcr.io/me/app:1.2');
		expect(plan.targets).toEqual(['app']);
	});
});
