import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { repoRestoreUpdates } from '../src/lib/utils/git-backfill-restore';

describe('git-backfill repoRestoreUpdates (partial rollback — H4)', () => {
	it('restores only the keys the promotion actually wrote', () => {
		// Schedule-only promotion: repo already had its own webhook, so the
		// snapshot has schedule keys but no webhook keys. Restoring must NOT
		// clobber webhookEnabled/webhookSecret (previously it forced them
		// false/null, disabling an untouched repo webhook).
		const updates = repoRestoreUpdates({
			autoUpdate: false,
			autoUpdateSchedule: 'daily',
			autoUpdateCron: '0 3 * * *'
		});
		assert.deepEqual(updates, {
			autoUpdate: false,
			autoUpdateSchedule: 'daily',
			autoUpdateCron: '0 3 * * *'
		});
		assert.equal('webhookEnabled' in updates, false);
		assert.equal('webhookSecret' in updates, false);
	});

	it('webhook-only promotion never clobbers a repo schedule', () => {
		const updates = repoRestoreUpdates({
			webhookEnabled: false,
			webhookSecret: null
		});
		assert.deepEqual(updates, { webhookEnabled: false, webhookSecret: null });
		assert.equal('autoUpdate' in updates, false);
		assert.equal('autoUpdateCron' in updates, false);
	});

	it('full promotion restores all five keys, preserving explicit false/null', () => {
		const updates = repoRestoreUpdates({
			autoUpdate: false,
			autoUpdateSchedule: null,
			autoUpdateCron: null,
			webhookEnabled: false,
			webhookSecret: null
		});
		assert.equal(updates.autoUpdate, false);
		assert.equal(updates.webhookEnabled, false);
		assert.equal(updates.webhookSecret, null);
	});

	it('restore ignores the apply target block (targets drive applyBackfill, not restore)', () => {
		// computeBackfillSnapshot now records `apply` (the target values). Restore
		// must never write those — only the originals.
		const updates = repoRestoreUpdates({
			autoUpdate: false,
			autoUpdateSchedule: null,
			autoUpdateCron: null,
			apply: {
				autoUpdate: true,
				autoUpdateSchedule: 'daily',
				autoUpdateCron: '0 3 * * *',
				webhookEnabled: true,
				webhookSecret: 's3cret'
			}
		});
		assert.deepEqual(updates, {
			autoUpdate: false,
			autoUpdateSchedule: null,
			autoUpdateCron: null
		});
		assert.equal('webhookEnabled' in updates, false);
		assert.equal('webhookSecret' in updates, false);
	});
});
