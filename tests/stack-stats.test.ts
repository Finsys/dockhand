import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sumStackStats, groupStackStats } from '../src/lib/utils/stack-stats';

const GB = 1024 * 1024 * 1024;

function sample(cpu: number, mem: number, limit: number) {
	return { cpuPercent: cpu, memoryUsage: mem, memoryLimit: limit, networkRx: 10, networkTx: 20, blockRead: 30, blockWrite: 40 };
}

const project = (name: string) => ({ 'com.docker.compose.project': name });

describe('sumStackStats', () => {
	test('sums running containers and takes the max memory limit', () => {
		const stats = new Map([
			['a', sample(1.5, 100, 16 * GB)],
			['b', sample(2.25, 200, 1 * GB)]
		]);
		const totals = sumStackStats(
			[{ id: 'a', state: 'running' }, { id: 'b', state: 'running' }],
			(id) => stats.get(id)
		);
		expect(totals).toEqual({
			cpuPercent: 3.75,
			memoryUsage: 300,
			memoryLimit: 16 * GB,
			networkRx: 20,
			networkTx: 40,
			blockRead: 60,
			blockWrite: 80,
			runningCount: 2
		});
	});

	test('ignores non-running containers even when a stale sample exists', () => {
		const stats = new Map([
			['a', sample(1, 100, GB)],
			['b', sample(50, 999, GB)]
		]);
		const totals = sumStackStats(
			[{ id: 'a', state: 'running' }, { id: 'b', state: 'exited' }],
			(id) => stats.get(id)
		);
		expect(totals?.cpuPercent).toBe(1);
		expect(totals?.memoryUsage).toBe(100);
		expect(totals?.runningCount).toBe(1);
	});

	test('does not count a running container without a sample', () => {
		const stats = new Map([['a', sample(1, 100, GB)]]);
		const totals = sumStackStats(
			[{ id: 'a', state: 'running' }, { id: 'b', state: 'running' }],
			(id) => stats.get(id)
		);
		expect(totals?.runningCount).toBe(1);
	});

	test('returns null when nothing is running or sampled', () => {
		expect(sumStackStats([], () => undefined)).toBeNull();
		expect(sumStackStats([{ id: 'a', state: 'exited' }], () => sample(1, 1, 1))).toBeNull();
		expect(sumStackStats([{ id: 'a', state: 'running' }], () => undefined)).toBeNull();
	});
});

describe('groupStackStats', () => {
	test('groups by compose project, skips standalone containers, sorts by name', () => {
		const containers = [
			{ id: 'w1', state: 'running', labels: project('web') },
			{ id: 'w2', state: 'running', labels: project('web') },
			{ id: 'd1', state: 'running', labels: project('db') },
			{ id: 's1', state: 'running', labels: {} }
		];
		const stats = new Map([
			['w1', sample(1, 100, GB)],
			['w2', sample(2, 200, GB)],
			['d1', sample(4, 400, 2 * GB)],
			['s1', sample(8, 800, GB)]
		]);
		const result = groupStackStats(containers, stats);
		expect(result.map((r) => r.name)).toEqual(['db', 'web']);
		expect(result[0]).toMatchObject({ name: 'db', cpuPercent: 4, memoryUsage: 400, memoryLimit: 2 * GB, runningCount: 1 });
		expect(result[1]).toMatchObject({ name: 'web', cpuPercent: 3, memoryUsage: 300, memoryLimit: GB, runningCount: 2 });
	});

	test('omits a stack whose containers have no running sample', () => {
		const containers = [
			{ id: 'a', state: 'exited', labels: project('stopped') },
			{ id: 'b', state: 'running', labels: project('live') }
		];
		const result = groupStackStats(containers, new Map([['b', sample(1, 1, 1)]]));
		expect(result.map((r) => r.name)).toEqual(['live']);
	});
});

describe('a stats sample names its stack', () => {
	// A caller can total a stack from /api/containers/stats
	// alone, without fetching the container list and joining on id. The sampler
	// cannot be imported here (it reaches the Docker client through its imports),
	// so this pins the source - the fallback this repo uses for that situation.
	const sampler = readFileSync(
		new URL('../src/lib/server/container-stats.ts', import.meta.url),
		'utf8'
	);

	test('the sample carries the compose project label', () => {
		expect(sampler).toMatch(/stack:\s*container\.labels\?\.\['com\.docker\.compose\.project'\]/);
	});

	test('a standalone container reports null rather than being omitted', () => {
		// Undefined would drop the key from the JSON and leave a consumer guessing
		// whether the field exists at all.
		expect(sampler).toMatch(/\['com\.docker\.compose\.project'\]\s*\?\?\s*null/);
	});

	test('the sampler accepts labels, so the field cannot be silently absent', () => {
		expect(sampler).toMatch(/container:\s*\{[^}]*labels\?:/s);
	});

	test('the streaming endpoint reports it too', () => {
		// The UI reads only the stream, so a consumer following it must be able to
		// group by stack as well; two endpoints for the same thing must not differ.
		const stream = readFileSync(
			new URL('../src/routes/api/containers/stats/stream/+server.ts', import.meta.url),
			'utf8'
		);
		expect(stream).toMatch(/stack:\s*container\.labels\?\.\['com\.docker\.compose\.project'\]\s*\?\?\s*null/);
	});
});
