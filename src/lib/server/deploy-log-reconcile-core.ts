/**
 * Pure decision core for the deploy-log reconcile job.
 *
 * Compares the set of deploy-log files on disk against the set of run records in the
 * database and decides what to do about each side of the mismatch -- nothing else. It
 * touches neither the filesystem nor the database; the caller (deploy-log-reconcile.ts)
 * is responsible for gathering the two id sets and for carrying out the plan.
 *
 * The two failure modes are NOT symmetric, and that asymmetry is the whole point of
 * this module:
 * - A file without a record is deleted -- it is an orphan with nothing left to explain it.
 * - A record without a file is only marked, never deleted -- the metadata (when, who,
 *   what was built, which digest) stays valuable even once the log text itself is gone.
 *   Deleting the record here would be the "too eager" failure this job exists to avoid.
 */

export interface ReconcileInput {
	/** Run ids that have a deploy-log file on disk. */
	fileIds: string[];
	/** Run ids that have a run record in the database. */
	recordIds: string[];
}

export interface ReconcilePlan {
	/** Files to delete: present on disk, no matching record. */
	deleteFiles: string[];
	/** Records to mark (details.logMissing = true): present in the database, no matching file. */
	markMissing: string[];
}

export function planReconcile(input: ReconcileInput): ReconcilePlan {
	const recordIdSet = new Set(input.recordIds);
	const fileIdSet = new Set(input.fileIds);

	return {
		deleteFiles: input.fileIds.filter((id) => !recordIdSet.has(id)),
		markMissing: input.recordIds.filter((id) => !fileIdSet.has(id))
	};
}
