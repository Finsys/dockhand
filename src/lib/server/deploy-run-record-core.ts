import { createHash } from 'node:crypto';
import type { DeploySummary } from './deploy-summary-core';

/**
 * Assembles the `details` JSON stored on a stack_deploy schedule_executions row.
 *
 * Deliberately dependency-free (no db.ts, no filesystem) so it can be unit tested
 * under Bun -- see deploy-run-record.ts for the database-touching half that calls
 * this. Importing db.ts here would make this module unimportable under Bun
 * (better-sqlite3, ERR_DLOPEN_FAILED), breaking this file's own test and dragging
 * down every other test file that happens to run in the same process.
 */

export interface DeployRunOptions {
	pull: boolean;
	build: boolean;
	forceRecreate: boolean;
}

export interface BuildRunDetailsInput {
	options: DeployRunOptions;
	summary?: DeploySummary;
	exitCode: number;
	composeHash: string;
	envHash: string;
	logFile: string;
	/** Set when the run's output hit deploy-log-store's total-size budget and was cut off. */
	truncated?: boolean;
}

export interface DeployRunDetails {
	options: DeployRunOptions;
	summary?: DeploySummary;
	exitCode: number;
	composeHash: string;
	envHash: string;
	logFile: string;
	truncated?: boolean;
}

/**
 * The log file name is what ties this schedule_executions row to its log file on
 * disk (deploy-logs/<id>.log). Task 13's reconciler deletes any file whose id has
 * no matching record -- if the name were missing here, a live run's own file would
 * look orphaned and get eaten out from under it.
 */
export function buildRunDetails(input: BuildRunDetailsInput): DeployRunDetails {
	if (!input.logFile) {
		throw new Error('buildRunDetails: logFile is required to tie the record to its log file');
	}
	return {
		options: input.options,
		summary: input.summary,
		exitCode: input.exitCode,
		composeHash: input.composeHash,
		envHash: input.envHash,
		logFile: input.logFile,
		...(input.truncated ? { truncated: true } : {})
	};
}

/** SHA-256 of the compose file content used for this deploy, hex-encoded. */
export function hashComposeContent(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

/**
 * SHA-256 fingerprint of the effective env for this deploy (every var -- secret and
 * non-secret alike -- that will actually reach the container), hex-encoded. Sorted by
 * key so the same env always hashes to the same value regardless of object key order.
 * This is a change-fingerprint, not a secret store -- the hash alone can't be turned
 * back into the values it was built from, so hashing secret values in is safe even
 * though logging them would not be. Callers merge whatever sources make up their
 * effective env (DB non-secret + secret vars, or a request body's raw/array vars)
 * into one Record before calling this.
 */
export function hashEnvFingerprint(vars: Record<string, string>): string {
	const serialized = Object.keys(vars).sort().map((k) => `${k}=${vars[k]}`).join('\n');
	return createHash('sha256').update(serialized).digest('hex');
}
