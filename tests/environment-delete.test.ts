import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fetchEnvironmentDeleteCounts } from '../src/lib/utils/environment-delete';

describe('fetchEnvironmentDeleteCounts', () => {
	it('returns stack counts when both endpoints respond', async () => {
		const result = await fetchEnvironmentDeleteCounts(42, async (url) => {
			return new Response(JSON.stringify(url.includes('/api/git/') ? [{}, {}] : [{}]));
		});

		assert.deepEqual(result, {
			stackCount: 1,
			gitStackCount: 2,
			unknown: false
		});
	});

	it('fails closed when a disconnected endpoint rejects', async () => {
		const result = await fetchEnvironmentDeleteCounts(42, async (url) => {
			if (url.startsWith('/api/stacks')) {
				throw new Error('connection timed out');
			}
			return new Response(JSON.stringify([]));
		});

		assert.deepEqual(result, {
			stackCount: 0,
			gitStackCount: 0,
			unknown: true
		});
	});

	it('fails closed when an endpoint returns an invalid payload', async () => {
		const result = await fetchEnvironmentDeleteCounts(42, async (url) => {
			return url.includes('/api/git/')
				? new Response('{invalid json')
				: new Response(JSON.stringify([]));
		});

		assert.equal(result.unknown, true);
		assert.equal(result.gitStackCount, 0);
	});
});
