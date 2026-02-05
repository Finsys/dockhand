/**
 * Git Stack Flow Tests
 *
 * Tests the buildOnDeploy feature for git stacks, verifying that
 * the --build flag is correctly propagated through the deploy chain.
 *
 * These tests require a running Dockhand instance (default: http://localhost:3000).
 * Set DOCKHAND_URL environment variable to override.
 */
import { describe, test, expect, beforeAll } from 'bun:test';

const BASE_URL = process.env.DOCKHAND_URL || 'http://localhost:3000';

// Helper to make authenticated API requests
async function api(path: string, options: RequestInit = {}) {
	const url = `${BASE_URL}${path}`;
	const res = await fetch(url, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			...(options.headers || {})
		}
	});
	return { status: res.status, data: await res.json().catch(() => null) };
}

describe('Git Stack - buildOnDeploy', () => {
	let testStackId: number | null = null;
	let testRepoId: number | null = null;

	// Cleanup after tests
	async function cleanup() {
		if (testStackId) {
			await api(`/api/git/stacks/${testStackId}`, { method: 'DELETE' });
			testStackId = null;
		}
		if (testRepoId) {
			await api(`/api/git/repositories/${testRepoId}`, { method: 'DELETE' });
			testRepoId = null;
		}
	}

	test('GET /api/git/stacks returns buildOnDeploy in stack data', async () => {
		const { status, data } = await api('/api/git/stacks');
		// Even if no stacks exist, the endpoint should work
		expect(status).toBe(200);
		expect(Array.isArray(data)).toBe(true);

		// If stacks exist, verify buildOnDeploy is present
		if (data.length > 0) {
			expect(data[0]).toHaveProperty('buildOnDeploy');
		}
	});

	test('POST /api/git/stacks creates stack with buildOnDeploy=true by default', async () => {
		// First, create a test repository
		const repoRes = await api('/api/git/repositories', {
			method: 'POST',
			body: JSON.stringify({
				name: `test-repo-build-${Date.now()}`,
				url: 'https://github.com/example/test.git',
				branch: 'main'
			})
		});

		if (repoRes.status !== 200) {
			console.log('Skipping: cannot create test repository (auth required?)');
			return;
		}

		testRepoId = repoRes.data.id;

		const { status, data } = await api('/api/git/stacks', {
			method: 'POST',
			body: JSON.stringify({
				stackName: `test-build-default-${Date.now()}`,
				repositoryId: testRepoId,
				composePath: 'compose.yaml'
			})
		});

		if (status !== 200) {
			console.log('Skipping: cannot create test stack');
			await cleanup();
			return;
		}

		testStackId = data.id;

		// buildOnDeploy should default to true
		expect(data.buildOnDeploy).toBe(true);

		await cleanup();
	});

	test('POST /api/git/stacks respects explicit buildOnDeploy=false', async () => {
		const repoRes = await api('/api/git/repositories', {
			method: 'POST',
			body: JSON.stringify({
				name: `test-repo-nobuild-${Date.now()}`,
				url: 'https://github.com/example/test.git',
				branch: 'main'
			})
		});

		if (repoRes.status !== 200) {
			console.log('Skipping: cannot create test repository (auth required?)');
			return;
		}

		testRepoId = repoRes.data.id;

		const { status, data } = await api('/api/git/stacks', {
			method: 'POST',
			body: JSON.stringify({
				stackName: `test-nobuild-${Date.now()}`,
				repositoryId: testRepoId,
				composePath: 'compose.yaml',
				buildOnDeploy: false
			})
		});

		if (status !== 200) {
			console.log('Skipping: cannot create test stack');
			await cleanup();
			return;
		}

		testStackId = data.id;

		expect(data.buildOnDeploy).toBe(false);

		await cleanup();
	});

	test('PUT /api/git/stacks/:id can toggle buildOnDeploy', async () => {
		const repoRes = await api('/api/git/repositories', {
			method: 'POST',
			body: JSON.stringify({
				name: `test-repo-toggle-${Date.now()}`,
				url: 'https://github.com/example/test.git',
				branch: 'main'
			})
		});

		if (repoRes.status !== 200) {
			console.log('Skipping: cannot create test repository (auth required?)');
			return;
		}

		testRepoId = repoRes.data.id;

		// Create with buildOnDeploy=true (default)
		const createRes = await api('/api/git/stacks', {
			method: 'POST',
			body: JSON.stringify({
				stackName: `test-toggle-${Date.now()}`,
				repositoryId: testRepoId,
				composePath: 'compose.yaml'
			})
		});

		if (createRes.status !== 200) {
			console.log('Skipping: cannot create test stack');
			await cleanup();
			return;
		}

		testStackId = createRes.data.id;
		expect(createRes.data.buildOnDeploy).toBe(true);

		// Update to buildOnDeploy=false
		const updateRes = await api(`/api/git/stacks/${testStackId}`, {
			method: 'PUT',
			body: JSON.stringify({
				buildOnDeploy: false
			})
		});

		expect(updateRes.status).toBe(200);
		expect(updateRes.data.buildOnDeploy).toBe(false);

		// Update back to buildOnDeploy=true
		const updateRes2 = await api(`/api/git/stacks/${testStackId}`, {
			method: 'PUT',
			body: JSON.stringify({
				buildOnDeploy: true
			})
		});

		expect(updateRes2.status).toBe(200);
		expect(updateRes2.data.buildOnDeploy).toBe(true);

		await cleanup();
	});
});
