/**
 * Unit tests for deepDiff - the function that compares container inspect
 * snapshots before and after recreation.
 *
 * Run with: bun test tests/deep-diff.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { deepDiff } from '../src/lib/utils/diff';

describe('deepDiff', () => {
	test('identical objects return no diffs', () => {
		const a = { foo: 'bar', nested: { x: 1 } };
		expect(deepDiff(a, structuredClone(a))).toEqual([]);
	});

	test('detects top-level primitive change', () => {
		const diffs = deepDiff({ name: 'old' }, { name: 'new' });
		expect(diffs).toEqual(['name: "old" → "new"']);
	});

	test('detects nested property change', () => {
		const diffs = deepDiff(
			{ Config: { Hostname: 'abc' } },
			{ Config: { Hostname: 'def' } }
		);
		expect(diffs).toEqual(['Config.Hostname: "abc" → "def"']);
	});

	test('detects deeply nested change', () => {
		const diffs = deepDiff(
			{ NetworkSettings: { Networks: { bridge: { IPAddress: '172.17.0.2' } } } },
			{ NetworkSettings: { Networks: { bridge: { IPAddress: '172.17.0.5' } } } }
		);
		expect(diffs).toEqual([
			'NetworkSettings.Networks.bridge.IPAddress: "172.17.0.2" → "172.17.0.5"'
		]);
	});

	test('detects added key', () => {
		const diffs = deepDiff({ a: 1 }, { a: 1, b: 2 });
		expect(diffs).toEqual(['b: <missing> → 2']);
	});

	test('detects removed key', () => {
		const diffs = deepDiff({ a: 1, b: 2 }, { a: 1 });
		expect(diffs).toEqual(['b: 2 → <missing>']);
	});

	test('detects array change', () => {
		const diffs = deepDiff(
			{ HostConfig: { CapAdd: ['NET_ADMIN', 'SYS_TIME'] } },
			{ HostConfig: { CapAdd: ['NET_ADMIN'] } }
		);
		expect(diffs).toEqual([
			'HostConfig.CapAdd: ["NET_ADMIN","SYS_TIME"] → ["NET_ADMIN"]'
		]);
	});

	test('identical arrays return no diffs', () => {
		const diffs = deepDiff(
			{ Env: ['A=1', 'B=2'] },
			{ Env: ['A=1', 'B=2'] }
		);
		expect(diffs).toEqual([]);
	});

	test('detects null vs object', () => {
		const diffs = deepDiff(
			{ Config: { Healthcheck: null } },
			{ Config: { Healthcheck: { Test: ['CMD', 'true'] } } }
		);
		expect(diffs).toEqual([
			'Config.Healthcheck: null → {"Test":["CMD","true"]}'
		]);
	});

	test('detects type change (string to number)', () => {
		const diffs = deepDiff({ x: '123' }, { x: 123 });
		expect(diffs).toEqual(['x: "123" → 123']);
	});

	test('detects boolean change', () => {
		const diffs = deepDiff(
			{ HostConfig: { Privileged: false } },
			{ HostConfig: { Privileged: true } }
		);
		expect(diffs).toEqual(['HostConfig.Privileged: false → true']);
	});

	test('handles empty objects', () => {
		expect(deepDiff({}, {})).toEqual([]);
	});

	test('handles full mock inspect diff', () => {
		const before = {
			Id: 'sha256:aaa',
			Created: '2026-02-09T10:00:00Z',
			Name: '/mycontainer',
			Config: {
				Hostname: 'mycontainer',
				Env: ['FOO=bar'],
				Image: 'nginx:1.25',
				Labels: { app: 'web' }
			},
			HostConfig: {
				Memory: 268435456,
				PortBindings: { '80/tcp': [{ HostIp: '', HostPort: '8080' }] },
				RestartPolicy: { Name: 'always', MaximumRetryCount: 0 },
				Binds: ['/data:/data:rw'],
				CapAdd: ['NET_ADMIN'],
				Privileged: false
			},
			NetworkSettings: {
				Networks: {
					bridge: { IPAddress: '172.17.0.2', MacAddress: '02:42:ac:11:00:02' },
					custom: { IPAddress: '10.0.0.5', MacAddress: '02:42:0a:00:00:05' }
				}
			},
			Mounts: [
				{ Type: 'bind', Source: '/data', Destination: '/data', RW: true }
			]
		};

		const after = {
			Id: 'sha256:bbb',
			Created: '2026-02-10T12:00:00Z',
			Name: '/mycontainer',
			Config: {
				Hostname: 'mycontainer',
				Env: ['FOO=bar'],
				Image: 'nginx:1.26',
				Labels: { app: 'web' }
			},
			HostConfig: {
				Memory: 268435456,
				PortBindings: { '80/tcp': [{ HostIp: '', HostPort: '8080' }] },
				RestartPolicy: { Name: 'always', MaximumRetryCount: 0 },
				Binds: ['/data:/data:rw'],
				CapAdd: ['NET_ADMIN'],
				Privileged: false
			},
			NetworkSettings: {
				Networks: {
					bridge: { IPAddress: '172.17.0.2', MacAddress: '02:42:ac:11:00:09' },
					custom: { IPAddress: '10.0.0.5', MacAddress: '02:42:0a:00:00:05' }
				}
			},
			Mounts: [
				{ Type: 'bind', Source: '/data', Destination: '/data', RW: true }
			]
		};

		const diffs = deepDiff(before, after);

		// Should detect Id, Created, Image, and MAC change - nothing else
		expect(diffs).toContainEqual('Id: "sha256:aaa" → "sha256:bbb"');
		expect(diffs).toContainEqual('Created: "2026-02-09T10:00:00Z" → "2026-02-10T12:00:00Z"');
		expect(diffs).toContainEqual('Config.Image: "nginx:1.25" → "nginx:1.26"');
		expect(diffs).toContainEqual(
			'NetworkSettings.Networks.bridge.MacAddress: "02:42:ac:11:00:02" → "02:42:ac:11:00:09"'
		);

		// Everything else should be preserved
		expect(diffs).toHaveLength(4);
	});

	test('detects network added/removed', () => {
		const before = {
			NetworkSettings: {
				Networks: {
					bridge: { IPAddress: '172.17.0.2' }
				}
			}
		};
		const after = {
			NetworkSettings: {
				Networks: {
					bridge: { IPAddress: '172.17.0.2' },
					custom: { IPAddress: '10.0.0.5' }
				}
			}
		};

		const diffs = deepDiff(before, after);
		expect(diffs).toContainEqual(
			'NetworkSettings.Networks.custom: <missing> → {"IPAddress":"10.0.0.5"}'
		);
	});

	test('detects HostConfig nested changes', () => {
		const diffs = deepDiff(
			{
				HostConfig: {
					Sysctls: { 'net.core.somaxconn': '1024' },
					Tmpfs: { '/tmp': 'rw,noexec' },
					LogConfig: { Type: 'json-file', Config: { 'max-size': '10m' } }
				}
			},
			{
				HostConfig: {
					Sysctls: { 'net.core.somaxconn': '2048' },
					Tmpfs: { '/tmp': 'rw,noexec' },
					LogConfig: { Type: 'json-file', Config: { 'max-size': '50m' } }
				}
			}
		);

		expect(diffs).toContainEqual(
			'HostConfig.Sysctls.net.core.somaxconn: "1024" → "2048"'
		);
		expect(diffs).toContainEqual(
			'HostConfig.LogConfig.Config.max-size: "10m" → "50m"'
		);
		expect(diffs).toHaveLength(2);
	});
});
