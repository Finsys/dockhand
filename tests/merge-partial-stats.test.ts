import { describe, it, expect } from 'bun:test';
import { mergePartialStats, definedPartialForStore } from '../src/lib/utils/merge-partial-stats';

describe('mergePartialStats - skeleton placeholders never blank a populated tile', () => {
	it('a skeleton partial (running:0, loading.containers=true) does NOT overwrite the real count', () => {
		// The #1608 case: a re-opened stream sends the zeroed skeleton for env 5, which
		// already shows 8 running. The zeros must be ignored.
		const existing: any = {
			id: 5,
			online: true,
			containers: { total: 8, running: 8, stopped: 0, paused: 0, restarting: 0, unhealthy: 0, pendingUpdates: 0 }
		};
		const skeleton: any = {
			id: 5,
			containers: { total: 0, running: 0, stopped: 0, paused: 0, restarting: 0, unhealthy: 0, pendingUpdates: 0 },
			loading: { containers: true }
		};
		mergePartialStats(existing, skeleton);
		expect(existing.containers.running).toBe(8); // preserved
		expect(existing.containers.total).toBe(8);
		expect(existing.loading).toEqual({ containers: true }); // spinner shows
	});

	it('a REAL partial (loading.containers=false) applies the counts', () => {
		const existing: any = {
			id: 5,
			containers: { total: 0, running: 0, stopped: 0, paused: 0, restarting: 0, unhealthy: 0, pendingUpdates: 0 },
			loading: { containers: true }
		};
		const real: any = {
			id: 5,
			online: true,
			containers: { total: 8, running: 8, stopped: 0, paused: 0, restarting: 0, unhealthy: 0, pendingUpdates: 0 },
			loading: { containers: false }
		};
		mergePartialStats(existing, real);
		expect(existing.containers.running).toBe(8);
		expect(existing.online).toBe(true);
		expect(existing.loading.containers).toBe(false);
	});

	it('a GENUINE drop to zero (running 8 -> 0 with loading:false) IS applied, not treated as a placeholder', () => {
		// The other direction of the guard: a user stops all containers. The real partial
		// carries loading.containers=false, so the zero must overwrite the prior 8 - it is
		// NOT a skeleton placeholder. (A regression that special-cased zero would freeze at 8.)
		const existing: any = { containers: { total: 8, running: 8, stopped: 0, paused: 0, restarting: 0, unhealthy: 0, pendingUpdates: 0 } };
		const stopAll: any = {
			containers: { total: 8, running: 0, stopped: 8, paused: 0, restarting: 0, unhealthy: 0, pendingUpdates: 0 },
			loading: { containers: false }
		};
		mergePartialStats(existing, stopAll);
		expect(existing.containers.running).toBe(0);
		expect(existing.containers.stopped).toBe(8);
	});

	it('a genuine zero for a non-container section (images 12 -> 0 with loading:false) IS applied', () => {
		const existing: any = { images: { total: 12, totalSize: 999 } };
		mergePartialStats(existing, { images: { total: 0, totalSize: 0 }, loading: { images: false } });
		expect(existing.images.total).toBe(0);
		expect(existing.images.totalSize).toBe(0);
	});

	it('a loading-only partial (no section payload) merges the loading flags, keeping prior data', () => {
		const existing: any = { containers: { running: 8 }, loading: { containers: true } };
		mergePartialStats(existing, { loading: { images: false } });
		expect(existing.containers.running).toBe(8); // untouched (no container payload)
		expect(existing.loading).toEqual({ containers: true, images: false }); // loading is deep-merged
	});

	it('an offline partial (online:false, error, loading:undefined) applies the scalars and skips undefined', () => {
		const existing: any = { online: true, containers: { running: 8 } };
		mergePartialStats(existing, { online: false, error: 'Connection timeout', loading: undefined });
		expect(existing.online).toBe(false);
		expect(existing.error).toBe('Connection timeout');
		expect(existing.containers.running).toBe(8); // no container payload -> untouched
		expect('loading' in existing && existing.loading === undefined).toBe(false); // undefined loading skipped
	});

	it('mixes sections: applies a ready section while skipping a still-loading one', () => {
		const existing: any = {
			containers: { running: 8 },
			images: { total: 12 }
		};
		const partial: any = {
			containers: { running: 0 }, // still loading -> keep 8
			images: { total: 15 }, // ready -> apply
			loading: { containers: true, images: false }
		};
		mergePartialStats(existing, partial);
		expect(existing.containers.running).toBe(8);
		expect(existing.images.total).toBe(15);
	});

	it('applies sections that have NO loading flag (online, metrics, events) - only flagged ones are placeholders', () => {
		// online/metrics/events carry no per-section loading flag; a real partial must apply
		// them even when it only flags `containers`. The skip is `loading[key] === true`, so a
		// missing flag (undefined) is NOT a placeholder.
		const existing: any = { online: false, metrics: null, containers: { running: 0 } };
		const real: any = {
			online: true,
			metrics: { cpuPercent: 5 },
			containers: { running: 8 },
			loading: { containers: false }
		};
		mergePartialStats(existing, real);
		expect(existing.online).toBe(true);
		expect(existing.metrics).toEqual({ cpuPercent: 5 });
		expect(existing.containers.running).toBe(8);
	});

	it('merges non-object scalars and preserves untouched keys', () => {
		const existing: any = { online: false, name: 'kasm', containers: { running: 8 } };
		mergePartialStats(existing, { online: true });
		expect(existing.online).toBe(true);
		expect(existing.name).toBe('kasm');
		expect(existing.containers.running).toBe(8);
	});

	it('ignores undefined values and the id key', () => {
		const existing: any = { id: 5, containers: { running: 8 } };
		mergePartialStats(existing, { id: 99, containers: undefined });
		expect(existing.id).toBe(5); // id never overwritten
		expect(existing.containers.running).toBe(8);
	});
});

describe('mergePartialStats - event-triggered refresh keeps lists the non-stream endpoint omits', () => {
	// The non-streaming /api/dashboard/stats does not compute topContainers/recentEvents
	// (only the SSE stream does). An event-triggered refresh must MERGE its response so the
	// richer lists a tile already got from the stream survive, instead of being blanked.
	it('undefined topContainers/recentEvents in the refresh keep the stream-provided lists', () => {
		// existing = what the SSE stream delivered
		const existing: any = {
			id: 8,
			containers: { total: 8, running: 8, stopped: 0 },
			topContainers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }, { id: 'g' }, { id: 'h' }],
			recentEvents: Array.from({ length: 10 }, (_, i) => ({ action: 'start', container_name: `c${i}` })),
			events: { today: 400, total: 700 }
		};
		// partial = the non-stream refresh: correct counts, no lists (fields omitted)
		mergePartialStats(existing, {
			id: 8,
			containers: { total: 8, running: 8, stopped: 0 },
			topContainers: undefined,
			recentEvents: undefined,
			events: { today: 488, total: 712 }
		});
		expect(existing.topContainers.length).toBe(8); // preserved, not blanked
		expect(existing.recentEvents.length).toBe(10); // preserved, not blanked
		expect(existing.events).toEqual({ today: 488, total: 712 }); // fresh counts applied
		expect(existing.containers.running).toBe(8);
	});

	it('a genuine empty topContainers array (present, no loading flag) DOES replace', () => {
		// If the endpoint ever explicitly sends [] (real "no running containers"), honour it.
		const existing: any = { id: 8, topContainers: [{ id: 'a' }] };
		mergePartialStats(existing, { id: 8, topContainers: [] });
		expect(existing.topContainers).toEqual([]);
	});
});

describe('definedPartialForStore - store payload drops placeholder sections but keeps loading', () => {
	it('drops a loading section, keeps loading + ready sections', () => {
		const partial: any = {
			id: 5,
			containers: { running: 0 },
			images: { total: 15 },
			loading: { containers: true, images: false }
		};
		const out = definedPartialForStore(partial);
		expect(out.containers).toBeUndefined(); // placeholder dropped
		expect(out.images).toEqual({ total: 15 }); // ready kept
		expect(out.loading).toEqual({ containers: true, images: false }); // always kept
		expect(out.id).toBe(5);
	});

	it('drops undefined values', () => {
		const out = definedPartialForStore({ id: 1, online: undefined, containers: { running: 3 } });
		expect('online' in out).toBe(false);
		expect(out.containers).toEqual({ running: 3 });
	});
});
