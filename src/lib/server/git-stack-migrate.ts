/**
 * Per-stack migrate-to-centralized job.
 *
 * Replaces the old whole-fleet mode transition with a job
 * that migrates an EXPLICIT set of stack ids. A persisted single-row state
 * machine (git_migration_state) tracks: idle → draining → provisioning →
 * cutting_over → idle. The terminal success state is `idle`, so the 409 lock
 * can never wedge. On failure the job rolls back the fields IT changed
 * (forceRedeploy + any promoted repo settings) and returns to `idle` with the
 * error — engine stays `stack`, so nothing was cut over.
 *
 * The lock is NARROW: git APIs only 409 when they touch a stack in this job's
 * stackIds or a repository it is provisioning — unrelated stacks keep working.
 */

import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { db, gitStacks, gitRepositories, eq, inArray, and } from './db/drizzle.js';
import {
	getGitMigrationState,
	updateGitMigrationState,
	getGitStack,
	getGitRepository,
	getGitRepositories,
	updateGitStack,
	updateGitRepository,
	type GitMigrationPhase,
	type GitStackWithRepo,
	type GitRepositoryData
} from './db';
import { ConflictError } from './git-mode';
import { provisionSharedClone, getGitReposDir } from './git';
import { getStackRepoPath, getActiveStackDeployIds } from './git-stack';
import { unregisterSchedule, registerSchedule } from './scheduler';
import { getActiveGitCoalesceIds } from './git-centralized';
import { computeMigrationPlan } from '../utils/git-migration-plan';
import { repoRestoreUpdates } from '../utils/git-backfill-restore';
import type { BackfillSnapshot, ForceRedeploySnapshot } from './git-backfill';

const DRAIN_TIMEOUT_MS = Number(process.env.DOCKHAND_GIT_TRANSITION_DRAIN_TIMEOUT_MS ?? 120_000);
const DRAIN_POLL_MS = 500;

/** In-memory mutexes: only one migration job may run/start at a time. */
let migrateRunning = false;
let migrateStarting = false;

async function setState(state: GitMigrationPhase): Promise<void> {
	await updateGitMigrationState({ state });
}

/**
 * Start a per-stack migration in the background. Throws ConflictError when a
 * job is already active or none of the requested ids is a stack-model stack.
 */
export async function startGitMigration(stackIds: number[]): Promise<void> {
	if (migrateStarting || migrateRunning) {
		throw new ConflictError('A git stack migration is already in progress');
	}
	migrateStarting = true;
	try {
		const active = await getGitMigrationState();
		if (active && active.state !== 'idle') {
			throw new ConflictError('A git stack migration is already in progress');
		}
		const stacks = await loadStackModelRows(stackIds);
		if (stacks.length === 0) {
			throw new ConflictError('No stack-model git stacks match the requested ids');
		}

		await updateGitMigrationState({
			state: 'draining',
			jobId: `git-stack-migrate-${Date.now()}`,
			stackIds: JSON.stringify(stacks.map((s) => s.id)),
			startedAt: new Date().toISOString(),
			finishedAt: null,
			snapshot: null,
			error: null
		});

		void runMigrationCore(stacks).catch((err) => {
			console.error('[GitStackMigrate] background job failed:', err instanceof Error ? err.message : String(err));
		});
	} finally {
		migrateStarting = false;
	}
}

/** Load the stack-model rows for the requested ids (missing/centralized ignored). */
async function loadStackModelRows(stackIds: number[]): Promise<GitStackWithRepo[]> {
	const stacks = await getGitStacksByIds(stackIds);
	return stacks.filter((s) => s.engine === 'stack');
}

async function getGitStacksByIds(stackIds: number[]): Promise<GitStackWithRepo[]> {
	if (stackIds.length === 0) return [];
	const stacks = await Promise.all(stackIds.map((id) => getGitStack(id)));
	return stacks.filter((s) => s !== null) as GitStackWithRepo[];
}

/**
 * Resume an interrupted migration job at boot. Only resumes the per-stack job;
 * nothing here migrates stacks that were never selected.
 */
export async function ensureGitMigrationsResolved(): Promise<void> {
	const job = await getGitMigrationState();
	if (!job || job.state === 'idle') return;
	let stackIds: number[];
	try {
		stackIds = JSON.parse(job.stackIds ?? '[]');
	} catch {
		console.error('[GitStackMigrate] Unreadable stack_ids on interrupted job — marking idle');
		await updateGitMigrationState({ state: 'idle', error: 'Unreadable stack_ids on interrupted job', finishedAt: new Date().toISOString() });
		return;
	}
	const stacks = await getGitStacksByIds(stackIds);
	if (stacks.length === 0) {
		await updateGitMigrationState({ state: 'idle', finishedAt: new Date().toISOString(), error: 'Interrupted job had no matching stacks' });
		return;
	}
	console.log('[GitStackMigrate] Resuming interrupted migration job...');
	await runMigrationCore(stacks);
}

async function runMigrationCore(stacks: GitStackWithRepo[]): Promise<void> {
	if (migrateRunning) {
		console.warn('[GitStackMigrate] A migration is already running — skipping duplicate');
		return;
	}
	migrateRunning = true;
	const stackIds = stacks.map((s) => s.id);
	const repoIdSet = new Set(stacks.map((s) => s.repositoryId));
	const repoIds = [...repoIdSet];
	// Snapshot every selected stack's pre-migration row so repoIds can be derived
	// on resume even when the rows changed.
	let snapshot: BackfillSnapshot | null = null;
	let cutoverCommitted = false;
	try {
		// ---- DRAINING (selected stacks / their repos only) ----
		await setState('draining');
		await waitForSelectedIdle(stackIds, repoIds);

		// ---- PROVISIONING ----
		await setState('provisioning');
		for (const repoId of repoIds) {
			console.log(`[GitStackMigrate] Provisioning shared clone for repository ${repoId}...`);
			const result = await provisionSharedClone(repoId);
			if (!result.success) {
				throw new Error(`Failed to provision shared clone for repository ${repoId}: ${result.error}`);
			}
		}

		// Snapshot (persisted BEFORE apply so a crash mid-apply resumes from it).
		// On RESUME reuse the persisted snapshot — recomputing one from already
		// backfilled rows would capture post-apply values and break rollback (the
		// same F13/N4 bug class the retired fleet transition guarded against).
		const currentJob = await getGitMigrationState();
		if (currentJob?.snapshot) {
			try {
				snapshot = JSON.parse(currentJob.snapshot);
			} catch {
				snapshot = null;
			}
		}
		if (!snapshot) {
			snapshot = await computeScopedBackfillSnapshot(stacks);
			await updateGitMigrationState({ snapshot: JSON.stringify(snapshot) });
		}
		await applyScopedBackfill(snapshot);

		// ---- CUTTING OVER ----
		await setState('cutting_over');
		await db.update(gitStacks)
			.set({ engine: 'centralized', updatedAt: new Date().toISOString() })
			.where(inArray(gitStacks.id, stackIds));
		cutoverCommitted = true;
		for (const id of stackIds) {
			unregisterSchedule(id, 'git_stack_sync');
		}
		for (const repoId of repoIds) {
			const repo = await getGitRepository(repoId);
			if (repo?.autoUpdate) {
				await registerSchedule(repo.id, 'git_repository_sync', null);
			}
		}

		// Cleanup per-stack clone dirs for the SELECTED ids only, after the shared
		// clone is healthy. Best-effort: a failure here must NOT roll back a
		// committed cutover.
		try {
			for (const stack of stacks) {
				await removePerStackClones(stack.id, stack.stackName, stack.environmentId);
			}
		} catch (cleanupErr) {
			console.warn(`[GitStackMigrate] Per-stack clone cleanup failed after cutover (best-effort): ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
		}

		await updateGitMigrationState({ state: 'idle', finishedAt: new Date().toISOString(), error: null, snapshot: null });
		console.log(`[GitStackMigrate] Migrated ${stackIds.length} stack(s) to centralized mode`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[GitStackMigrate] Migration failed: ${message}`);
		if (!cutoverCommitted) {
			try {
				const row = await getGitMigrationState();
				if (row?.snapshot) {
					await restoreScopedBackfill(JSON.parse(row.snapshot));
				}
			} catch (rollbackErr) {
				console.error('[GitStackMigrate] Rollback failed:', rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr));
			}
		} else {
			console.warn('[GitStackMigrate] Cutover already committed — recording error without rollback');
		}
		await updateGitMigrationState({ state: 'idle', finishedAt: new Date().toISOString(), error: message, snapshot: null });
		throw err;
	} finally {
		migrateRunning = false;
	}
}

/**
 * Wait until the SELECTED stacks and their repos are quiescent. Only in-flight
 * work on the selected ids is waited on: the stack engine's per-stack deploy
 * ids and the centralized engine's per-id coalesce slots, plus the syncing
 * status columns. Unrelated stacks deploying/syncing never block or abort this
 * job (migrating stack 2 must not wait on stack 1). Bounded wait — abort the
 * migration if a selected stack never finishes.
 */
async function waitForSelectedIdle(stackIds: number[], repoIds: number[]): Promise<void> {
	const deadline = Date.now() + DRAIN_TIMEOUT_MS;
	for (;;) {
		const [busyStacks, busyRepos, deployIds, coalesce] = await Promise.all([
			db.select({ id: gitStacks.id }).from(gitStacks)
				.where(and(inArray(gitStacks.id, stackIds), eq(gitStacks.syncStatus, 'syncing'))),
			repoIds.length > 0
				? db.select({ id: gitRepositories.id }).from(gitRepositories)
					.where(and(inArray(gitRepositories.id, repoIds), eq(gitRepositories.syncStatus, 'syncing')))
				: Promise.resolve([]),
			getActiveStackDeployIds(),
			getActiveGitCoalesceIds()
		]);
		const pendingStackIds = new Set([
			...busyStacks.map((r: { id: number }) => r.id),
			...deployIds.filter((id) => stackIds.includes(id))
		]);
		const pendingRepoIds = new Set([
			...busyRepos.map((r: { id: number }) => r.id),
			...coalesce.repos.filter((id) => repoIds.includes(id))
		]);
		if (pendingStackIds.size === 0 && pendingRepoIds.size === 0) return;
		if (Date.now() >= deadline) {
			throw new Error(
				`Git operations still in flight (${pendingStackIds.size} stack(s), ${pendingRepoIds.size} repo(s)) — aborting stack migration`
			);
		}
		await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
	}
}

/**
 * Read-only snapshot scoped to the stacks THIS job migrates: original
 * forceRedeploy values for selected webhook-enabled stacks, and original
 * repo-level fields only for repos this job would promote a schedule/webhook
 * onto (never derived from unselected siblings). The ranking/promotion decision
 * is pure (computeMigrationPlan) and unit-tested.
 */
export async function computeScopedBackfillSnapshot(stacks: GitStackWithRepo[]): Promise<BackfillSnapshot> {
	const repos = await getGitRepositories();
	const plan = computeMigrationPlan(stacks, repos);
	return {
		forceRedeploy: plan.forceRedeploy,
		repoSettings: plan.repos as BackfillSnapshot['repoSettings']
	};
}

/** Apply the scoped snapshot: set forceRedeploy + promote repo schedule/webhook. */
export async function applyScopedBackfill(snapshot: BackfillSnapshot): Promise<void> {
	for (const [stackIdStr] of Object.entries(snapshot.forceRedeploy)) {
		await updateGitStack(Number(stackIdStr), { forceRedeploy: true });
	}
	for (const [repoIdStr, plan] of Object.entries(snapshot.repoSettings)) {
		const repoId = Number(repoIdStr);
		const apply = plan.apply;
		if (!apply) continue;
		const updates: Partial<GitRepositoryData> = {};
		if (apply.autoUpdate !== undefined) updates.autoUpdate = apply.autoUpdate;
		if (apply.autoUpdateSchedule !== undefined) updates.autoUpdateSchedule = apply.autoUpdateSchedule;
		if (apply.autoUpdateCron !== undefined) updates.autoUpdateCron = apply.autoUpdateCron;
		if (apply.webhookEnabled !== undefined) updates.webhookEnabled = apply.webhookEnabled;
		if (apply.webhookSecret !== undefined) updates.webhookSecret = apply.webhookSecret;
		await updateGitRepository(repoId, updates);
	}
}

/** Restore a scoped snapshot exactly (rollback path). Only the fields this job wrote. */
export async function restoreScopedBackfill(snapshot: BackfillSnapshot | null): Promise<void> {
	if (!snapshot) return;
	for (const [stackIdStr, original] of Object.entries(snapshot.forceRedeploy)) {
		await updateGitStack(Number(stackIdStr), { forceRedeploy: original });
	}
	for (const [repoIdStr, original] of Object.entries(snapshot.repoSettings)) {
		await updateGitRepository(Number(repoIdStr), repoRestoreUpdates(original));
	}
}

/**
 * Remove a single stack's per-stack clone trees — git-repos/stack-<id> (the
 * fallback layout) and the env-scoped git-repos/<envName>/<stackName> tree.
 * Each tree belongs to exactly one stack, so removing them can never touch a
 * sibling's clone (no env-directory wipe).
 */
async function removePerStackClones(stackId: number, stackName?: string, environmentId?: number | null): Promise<void> {
	const targets = new Set<string>([join(getGitReposDir(), `stack-${stackId}`)]);
	const envPath = await getStackRepoPath(stackId, stackName, environmentId);
	if (envPath !== join(getGitReposDir(), `stack-${stackId}`)) {
		targets.add(envPath);
	}
	for (const dir of targets) {
		await rm(dir, { recursive: true, force: true });
		console.log(`[GitStackMigrate] Removed per-stack clone: ${dir}`);
	}
}

// Re-export the snapshot shape for tests/type consumers.
export type { ForceRedeploySnapshot };