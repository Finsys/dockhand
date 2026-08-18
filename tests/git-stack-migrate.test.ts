import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeMigrationPlan } from '../src/lib/utils/git-migration-plan';
import { isStackInMigrationScope } from '../src/lib/utils/git-migration-scope';

describe('isStackInMigrationScope — scheduler tick suppression during a per-stack migration', () => {
	const scope = { stackIds: [2, 3], repoIds: [7] };

	it('suppresses a tick for a stack inside the migration scope', () => {
		assert.equal(isStackInMigrationScope(scope, 2), true);
		assert.equal(isStackInMigrationScope(scope, 3), true);
	});

	it('lets unrelated stacks tick normally', () => {
		assert.equal(isStackInMigrationScope(scope, 1), false);
		assert.equal(isStackInMigrationScope({ stackIds: [], repoIds: [] }, 2), false);
	});
});

describe('computeMigrationPlan — "migrate {2} leaves stack 1 untouched" (decision level)', () => {
	const stack = (id: number, repoId: number, extra: Partial<{ autoUpdate: boolean; autoUpdateSchedule: string | null; autoUpdateCron: string | null; webhookEnabled: boolean; webhookSecret: string | null; forceRedeploy: boolean }> = {}) => ({
		id,
		repositoryId: repoId,
		autoUpdate: false,
		autoUpdateSchedule: null,
		autoUpdateCron: null,
		webhookEnabled: false,
		webhookSecret: null,
		forceRedeploy: false,
		...extra
	});

	it('migrating only stack 2 never records forceRedeploy/schedule/webhook for stack 1', () => {
		// Both stacks share repo 7. Stack 1 has a webhook + schedule; stack 2 has
		// a webhook + schedule. Only stack 2 is in the migration.
		const stacks = [
			stack(1, 7, { webhookEnabled: true, webhookSecret: 's1', forceRedeploy: false, autoUpdate: true, autoUpdateSchedule: 'daily', autoUpdateCron: '0 3 * * *' }),
			stack(2, 7, { webhookEnabled: true, webhookSecret: 's2', forceRedeploy: false, autoUpdate: true, autoUpdateSchedule: 'daily', autoUpdateCron: '0 4 * * *' })
		];
		const repos = [{ id: 7, autoUpdate: false, webhookEnabled: false, webhookSecret: null }];

		const plan = computeMigrationPlan([stacks[1]], repos);

		// forceRedeploy is set only on the SELECTED webhook-enabled stack.
		assert.deepEqual(Object.keys(plan.forceRedeploy), ['2']);
		assert.equal(plan.forceRedeploy[2], false);

		// Repo promotion is derived from SELECTED stacks only: stack 1's schedule
		// and webhook secret must NOT contribute.
		const repoPlan = plan.repos[7];
		assert.ok(repoPlan, 'repo 7 must get a promotion (selected stack 2 wants one)');
		assert.equal(repoPlan.apply?.autoUpdate, true);
		assert.equal(repoPlan.apply?.autoUpdateCron, '0 4 * * *', 'winner must be the selected stack 2, not unselected stack 1');
		assert.equal(repoPlan.apply?.webhookSecret, 's2', 'webhook secret must come from the selected stack 2');
	});

	it('no promotion when the repo already has its own schedule/webhook', () => {
		const stacks = [stack(2, 7, { webhookEnabled: true, webhookSecret: 's2', forceRedeploy: false, autoUpdate: true, autoUpdateSchedule: 'daily', autoUpdateCron: '0 4 * * *' })];
		const repos = [{ id: 7, autoUpdate: true, autoUpdateSchedule: 'weekly', autoUpdateCron: '0 5 * * 0', webhookEnabled: true, webhookSecret: 'existing' }];

		const plan = computeMigrationPlan(stacks, repos);
		assert.deepEqual(Object.keys(plan.repos), [], 'repo already configured — nothing promoted');
	});

	it('unselected stacks are never in the plan, even on the same repo', () => {
		const stacks = [
			stack(1, 7, { forceRedeploy: false }),
			stack(2, 8, { webhookEnabled: true, webhookSecret: 's2', forceRedeploy: false })
		];
		const repos = [
			{ id: 7, autoUpdate: false, webhookEnabled: false, webhookSecret: null },
			{ id: 8, autoUpdate: false, webhookEnabled: false, webhookSecret: null }
		];

		const plan = computeMigrationPlan([stacks[1]], repos);
		assert.deepEqual(Object.keys(plan.forceRedeploy), ['2']);
		assert.deepEqual(Object.keys(plan.repos), ['8']);
	});
});
