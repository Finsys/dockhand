/**
 * Job ownership access control (canAccessJob).
 *
 * A job belongs to the user who created it (ownerId captured from the request
 * context). Only that user or an admin may read/cancel it. With auth disabled,
 * or for a job with no owner, access is open.
 */

import { describe, test, expect } from 'bun:test';
import { createJob, canAccessJob, type Job } from '../src/lib/server/jobs';
import { requestContext, type RequestContext } from '../src/lib/server/request-context';

function ctx(over: Partial<RequestContext>): RequestContext {
	return { user: null, authEnabled: true, authMethod: 'cookie', ...over };
}

function user(id: number, isAdmin = false) {
	return {
		id,
		username: `u${id}`,
		isAdmin,
		provider: 'local' as const,
		permissions: {} as any
	};
}

function jobOwnedBy(ownerId: number | null): Job {
	return {
		id: 'j',
		status: 'running',
		lines: [],
		createdAt: 0,
		updatedAt: 0,
		ownerId
	};
}

describe('createJob captures the owner from request context', () => {
	test('ownerId = current user id inside a request', () => {
		const job = requestContext.run(ctx({ user: user(7) }), () => createJob());
		expect(job.ownerId).toBe(7);
	});

	test('ownerId = null when there is no request context', () => {
		const job = createJob();
		expect(job.ownerId).toBeNull();
	});

	test('ownerId = null when auth is disabled', () => {
		const job = requestContext.run(ctx({ user: null, authEnabled: false }), () => createJob());
		expect(job.ownerId).toBeNull();
	});
});

describe('canAccessJob', () => {
	test('owner can access their own job', () => {
		const job = jobOwnedBy(7);
		const ok = requestContext.run(ctx({ user: user(7) }), () => canAccessJob(job));
		expect(ok).toBe(true);
	});

	test('admin can access another user\'s job', () => {
		const job = jobOwnedBy(7);
		const ok = requestContext.run(ctx({ user: user(99, true) }), () => canAccessJob(job));
		expect(ok).toBe(true);
	});

	test('a different non-admin user is denied', () => {
		const job = jobOwnedBy(7);
		const ok = requestContext.run(ctx({ user: user(8) }), () => canAccessJob(job));
		expect(ok).toBe(false);
	});

	test('an unauthenticated request (auth on) is denied an owned job', () => {
		const job = jobOwnedBy(7);
		const ok = requestContext.run(ctx({ user: null }), () => canAccessJob(job));
		expect(ok).toBe(false);
	});

	test('auth disabled: access is open even to an owned job', () => {
		const job = jobOwnedBy(7);
		const ok = requestContext.run(ctx({ user: null, authEnabled: false }), () => canAccessJob(job));
		expect(ok).toBe(true);
	});

	test('a job with no owner is open (auth enabled)', () => {
		const job = jobOwnedBy(null);
		const ok = requestContext.run(ctx({ user: user(8) }), () => canAccessJob(job));
		expect(ok).toBe(true);
	});

	test('no request context at all: access is open', () => {
		const job = jobOwnedBy(7);
		expect(canAccessJob(job)).toBe(true);
	});
});
