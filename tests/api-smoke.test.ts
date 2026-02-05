/**
 * API Smoke Tests
 *
 * Basic smoke tests that verify API endpoints are reachable and return
 * expected status codes. Requires a running Dockhand instance.
 *
 * Set DOCKHAND_URL environment variable to override (default: http://localhost:3000).
 */
import { describe, test, expect } from 'bun:test';

const BASE_URL = process.env.DOCKHAND_URL || 'http://localhost:3000';

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

describe('API Smoke Tests', () => {
	test('GET /api/health returns 200', async () => {
		const { status } = await api('/api/health');
		expect(status).toBe(200);
	});

	test('GET /api/system/version returns 200 with version info', async () => {
		const { status, data } = await api('/api/system/version');
		expect(status).toBe(200);
		expect(data).toBeDefined();
	});

	test('GET /api/environments returns 200 with array', async () => {
		const { status, data } = await api('/api/environments');
		expect(status).toBe(200);
		expect(Array.isArray(data)).toBe(true);
	});

	test('GET /api/stacks returns 200', async () => {
		const { status, data } = await api('/api/stacks');
		expect(status).toBe(200);
		expect(data).toBeDefined();
	});

	test('GET /api/registries returns 200 with array', async () => {
		const { status, data } = await api('/api/registries');
		expect(status).toBe(200);
		expect(Array.isArray(data)).toBe(true);
	});

	test('GET /api/git/repositories returns 200 with array', async () => {
		const { status, data } = await api('/api/git/repositories');
		expect(status).toBe(200);
		expect(Array.isArray(data)).toBe(true);
	});

	test('GET /api/git/stacks returns 200 with array', async () => {
		const { status, data } = await api('/api/git/stacks');
		expect(status).toBe(200);
		expect(Array.isArray(data)).toBe(true);
	});

	test('GET /api/notifications returns 200 with array', async () => {
		const { status, data } = await api('/api/notifications');
		expect(status).toBe(200);
		expect(Array.isArray(data)).toBe(true);
	});

	test('GET /api/auth/session returns session status', async () => {
		const { status } = await api('/api/auth/session');
		// 200 if auth disabled or valid session, 401 if auth enabled without session
		expect([200, 401]).toContain(status);
	});

	test('GET non-existent API endpoint returns 404', async () => {
		const { status } = await api('/api/this-endpoint-does-not-exist');
		expect(status).toBe(404);
	});
});
