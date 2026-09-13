/**
 * Unit tests for the "Append to existing" merge helpers (#489): merging a generated
 * single-service compose into an existing stack compose, and computing the highlight range
 * of the added service. No browser needed - pure js-yaml logic.
 *
 * Run with: bun test tests/compose-merge.test.ts
 */
import { describe, test, expect } from 'bun:test';
import yaml from 'js-yaml';
import { mergeServiceIntoCompose, computeAddedRange } from '../src/lib/utils/compose-merge';

const BASE = `services:
  web:
    image: nginx:latest
    ports:
      - '8080:80'
`;

describe('mergeServiceIntoCompose', () => {
	test('adds a new service under services without touching the existing one', () => {
		const service = `services:
  redis:
    image: redis:7
`;
		const { merged, key, renamed } = mergeServiceIntoCompose(BASE, service);
		expect(key).toBe('redis');
		expect(renamed).toBe(false);
		const doc = yaml.load(merged) as any;
		expect(Object.keys(doc.services).sort()).toEqual(['redis', 'web']);
		expect(doc.services.web.image).toBe('nginx:latest');
		expect(doc.services.redis.image).toBe('redis:7');
	});

	test('auto-suffixes on a name clash instead of overwriting', () => {
		const service = `services:
  web:
    image: caddy:2
`;
		const { merged, key, renamed } = mergeServiceIntoCompose(BASE, service);
		expect(key).toBe('web-2');
		expect(renamed).toBe(true);
		const doc = yaml.load(merged) as any;
		// original web is untouched, the added one is web-2
		expect(doc.services.web.image).toBe('nginx:latest');
		expect(doc.services['web-2'].image).toBe('caddy:2');
	});

	test('picks the lowest free suffix when -2 is also taken', () => {
		const base = `services:
  web:
    image: nginx:latest
  web-2:
    image: nginx:1.25
`;
		const service = `services:
  web:
    image: caddy:2
`;
		const { key } = mergeServiceIntoCompose(base, service);
		expect(key).toBe('web-3');
	});

	test('carries over top-level networks and volumes the service references', () => {
		const service = `services:
  db:
    image: postgres:16
    networks:
      - backend
    volumes:
      - pgdata:/var/lib/postgresql/data
networks:
  backend:
    external: true
volumes:
  pgdata:
    external: true
`;
		const { merged } = mergeServiceIntoCompose(BASE, service);
		const doc = yaml.load(merged) as any;
		expect(doc.networks.backend).toEqual({ external: true });
		expect(doc.volumes.pgdata).toEqual({ external: true });
	});

	test('handles an empty base compose (creates services)', () => {
		const service = `services:
  app:
    image: alpine
`;
		const { merged, key } = mergeServiceIntoCompose('', service);
		expect(key).toBe('app');
		expect((yaml.load(merged) as any).services.app.image).toBe('alpine');
	});
});

describe('computeAddedRange', () => {
	test('returns the exact block of the added service', () => {
		const service = `services:
  redis:
    image: redis:7
`;
		const { merged, key } = mergeServiceIntoCompose(BASE, service);
		const [range] = computeAddedRange(merged, key);
		const lines = merged.split('\n');
		// the highlighted range must start at the `  redis:` line
		expect(lines[range.line - 1]).toMatch(/^\s+redis:/);
		// and every highlighted line must be inside the redis block (indent > 2) or the header
		for (let l = range.line; l <= range.endLine; l++) {
			expect(lines[l - 1].startsWith('  ')).toBe(true);
		}
	});

	test('does NOT over-highlight the trailing blank line when the service is last', () => {
		// merged doc ends with the added service and a trailing newline from yaml.dump.
		const service = `services:
  last:
    image: busybox
`;
		const { merged, key } = mergeServiceIntoCompose(BASE, service);
		const [range] = computeAddedRange(merged, key);
		const lines = merged.split('\n');
		// endLine must be a real content line, not the trailing empty one.
		expect(lines[range.endLine - 1].trim()).not.toBe('');
	});

	test('returns empty when the key is absent', () => {
		expect(computeAddedRange(BASE, 'nope')).toEqual([]);
	});
});
