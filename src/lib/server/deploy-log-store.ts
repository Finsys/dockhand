import { appendFile, mkdir, readFile, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const ID = /^[A-Za-z0-9_-]+$/;

/**
 * A run id comes from a route parameter, so it is validated rather than sanitised:
 * a value that is not a plain id is a bug or an attack, and neither should quietly
 * resolve to some other file.
 */
export function runLogFileName(runId: string): string {
	if (!ID.test(runId)) throw new Error(`invalid run id: ${JSON.stringify(runId)}`);
	return `${runId}.log`;
}

function logDir(): string {
	return join(process.env.DATA_DIR || './data', 'deploy-logs');
}

export function runLogPath(runId: string): string {
	return join(logDir(), runLogFileName(runId));
}

/** Total bytes the log directory may occupy before new writes are refused. */
const BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

export async function appendRunLog(runId: string, chunk: string): Promise<void> {
	await mkdir(logDir(), { recursive: true });
	await appendFile(runLogPath(runId), chunk);
}

export async function readRunLog(runId: string): Promise<string | null> {
	try {
		return await readFile(runLogPath(runId), 'utf8');
	} catch {
		return null;
	}
}

export async function deleteRunLog(runId: string): Promise<void> {
	await rm(runLogPath(runId), { force: true });
}

export async function listRunLogIds(): Promise<string[]> {
	try {
		const names = await readdir(logDir());
		return names.filter((n) => n.endsWith('.log')).map((n) => n.slice(0, -4));
	} catch {
		return [];
	}
}

export async function usedBytes(): Promise<number> {
	let total = 0;
	for (const id of await listRunLogIds()) {
		try {
			total += (await stat(runLogPath(id))).size;
		} catch {
			/* raced with cleanup */
		}
	}
	return total;
}

export async function budgetExceeded(): Promise<boolean> {
	return (await usedBytes()) > BUDGET_BYTES;
}
