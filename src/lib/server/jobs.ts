import { randomUUID } from 'crypto';
import { getRequestContext } from './request-context';

export interface JobLine {
	event?: string; // 'result', 'progress', etc. — undefined for bare data lines
	data: unknown;
}

export interface Job {
	id: string;
	status: 'running' | 'done' | 'error';
	lines: JobLine[];
	result?: unknown;
	createdAt: number;
	updatedAt: number;
	/** Set when a client requests cancellation; long-running jobs should poll this. */
	cancelRequested?: boolean;
	/** User id that created the job, captured from the request context. null when auth is disabled. */
	ownerId: number | null;
}

const jobs = new Map<string, Job>();

export function createJob(): Job {
	const job: Job = {
		id: randomUUID(),
		status: 'running',
		lines: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		ownerId: getRequestContext()?.user?.id ?? null
	};
	jobs.set(job.id, job);
	return job;
}

/**
 * Whether the current request may read/cancel this job. Owner or admin only.
 * When auth is disabled (or the job has no owner) access is open, matching the
 * rest of the app's initial-setup behavior.
 */
export function canAccessJob(job: Job): boolean {
	const ctx = getRequestContext();
	if (!ctx || !ctx.authEnabled) return true;
	if (job.ownerId === null) return true;
	const user = ctx.user;
	if (!user) return false;
	return user.isAdmin || user.id === job.ownerId;
}

export function getJob(id: string): Job | undefined {
	return jobs.get(id);
}

/** Live job counts by status — for the metrics endpoint. */
export function getJobStats(): { running: number; done: number; error: number; total: number } {
	let running = 0, done = 0, error = 0;
	for (const job of jobs.values()) {
		if (job.status === 'running') running++;
		else if (job.status === 'done') done++;
		else if (job.status === 'error') error++;
	}
	return { running, done, error, total: jobs.size };
}

export function appendLine(job: Job, line: JobLine): void {
	job.lines.push(line);
	job.updatedAt = Date.now();
}

export function completeJob(job: Job, result: unknown): void {
	job.result = result;
	job.status = 'done';
	job.updatedAt = Date.now();
}

export function failJob(job: Job, error: string): void {
	job.result = { success: false, error };
	job.status = 'error';
	job.updatedAt = Date.now();
}

/** Request cancellation of a running job. The job's operation must poll job.cancelRequested. */
export function cancelJob(id: string): boolean {
	const job = jobs.get(id);
	if (!job || job.status !== 'running') return false;
	job.cancelRequested = true;
	job.updatedAt = Date.now();
	return true;
}

// Cleanup jobs older than 10 minutes that are no longer running
const CLEANUP_INTERVAL_MS = 60_000;
const JOB_TTL_MS = 10 * 60_000;

setInterval(() => {
	const cutoff = Date.now() - JOB_TTL_MS;
	for (const [id, job] of jobs) {
		if (job.status !== 'running' && job.updatedAt < cutoff) {
			jobs.delete(id);
		}
	}
}, CLEANUP_INTERVAL_MS);
