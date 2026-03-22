import { randomUUID } from 'crypto';

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
}

const jobs = new Map<string, Job>();

export function createJob(): Job {
	const job: Job = {
		id: randomUUID(),
		status: 'running',
		lines: [],
		createdAt: Date.now(),
		updatedAt: Date.now()
	};
	jobs.set(job.id, job);
	return job;
}

export function getJob(id: string): Job | undefined {
	return jobs.get(id);
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
