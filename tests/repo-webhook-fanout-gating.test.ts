import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	fanOutDeployStacks,
	mergeDeployGitStackOpts,
	mergeFanOutStackIds,
	filterStacksByEnvAccess,
	shouldDeployGitStack,
	type DeployGitStackOpts,
	type FanOutStack
} from '../src/lib/utils/git-deploy-gating';

interface TestStack extends FanOutStack {
	/** Whether the repository sync found changes for this stack. */
	updated: boolean;
}

/**
 * Faithful simulation of deployGitStackCore (git.ts): the (possibly
 * coalesced) deploy intent goes straight into shouldDeployGitStack. This is
 * the same composition the real fan-out uses, minus the DB/git/docker
 * machinery.
 */
function coreDeploy(opts: DeployGitStackOpts, stack: TestStack): { success: boolean; skipped: boolean } {
	const shouldDeploy = shouldDeployGitStack({
		force: opts.force,
		ignoreForceRedeploy: opts.ignoreForceRedeploy,
		forceRedeploy: stack.forceRedeploy,
		updated: stack.updated
	});
	return shouldDeploy ? { success: true, skipped: false } : { success: true, skipped: true };
}

describe('repo webhook fan-out gating', () => {
	it('skips stacks with their own webhook entirely — never calls deploy', async () => {
		const stacks: TestStack[] = [
			{ id: 1, stackName: 'own-webhook', forceRedeploy: true, webhookEnabled: true, updated: false },
			{ id: 2, stackName: 'plain-force', forceRedeploy: true, webhookEnabled: false, updated: false },
			{ id: 3, stackName: 'passive', forceRedeploy: false, webhookEnabled: false, updated: false }
		];

		const intents: Array<{ stackId: number; opts: DeployGitStackOpts }> = [];
		const result = await fanOutDeployStacks(stacks, (stackId, opts) => {
			const stack = stacks.find((s) => s.id === stackId)!;
			intents.push({ stackId, opts });
			return Promise.resolve(coreDeploy(opts, stack));
		});

		// Own-webhook stack: NOT called at all
		assert.equal(intents.find((i) => i.stackId === 1), undefined);
		// Plain forceRedeploy stack: honored, redeploys without changes
		assert.deepEqual(intents.find((i) => i.stackId === 2)?.opts, {
			force: false,
			ignoreForceRedeploy: false
		});
		assert.deepEqual(
			result.stacks.map((s) => [s.id, s.status, s.status === 'skipped' ? s.reason : undefined]),
			[[1, 'skipped', 'own-webhook'], [2, 'deployed', undefined], [3, 'skipped', undefined]]
		);
		assert.equal(result.success, true);
	});

	it('never deploys an own-webhook stack even when the sync found changes', async () => {
		// The whole point of the true skip: a push that hits both the repo webhook
		// and the stack webhook must not deploy the stack twice.
		const stacks: TestStack[] = [
			{ id: 1, stackName: 'own-webhook', forceRedeploy: true, webhookEnabled: true, updated: true }
		];

		const intents: Array<{ stackId: number; opts: DeployGitStackOpts }> = [];
		const result = await fanOutDeployStacks(stacks, (stackId, opts) => {
			const stack = stacks.find((s) => s.id === stackId)!;
			intents.push({ stackId, opts });
			return Promise.resolve(coreDeploy(opts, stack));
		});

		assert.deepEqual(intents, []);
		assert.deepEqual(
			result.stacks.map((s) => [s.id, s.status]),
			[[1, 'skipped']]
		);
	});

	it('keeps a stack-level webhook able to force redeploy its own stack', async () => {
		// Stack webhook path (scheduler runGitStackSync): deployGitStack(stackId,
		// { force: false }) — no ignoreForceRedeploy, so the stack's own
		// forceRedeploy setting is honored even without changes.
		const ownWebhookStack: TestStack = {
			id: 1,
			stackName: 'own-webhook',
			forceRedeploy: true,
			webhookEnabled: true,
			updated: false
		};

		const webhookIntent = { force: false, ignoreForceRedeploy: false };
		const result = coreDeploy(webhookIntent, ownWebhookStack);

		assert.equal(result.skipped, false);
		assert.equal(
			shouldDeployGitStack({
				force: false,
				ignoreForceRedeploy: false,
				forceRedeploy: true,
				updated: false
			}),
			true,
			'stack webhook must force-redeploy the stack even when nothing changed'
		);
	});

	it('stack webhook intent wins over the repo fan-out deferral in a race', () => {
		// Concurrent coalescing (runCoalesced): the fan-out intent
		// { force: false, ignoreForceRedeploy: true } and the stack webhook's
		// { force: false, ignoreForceRedeploy: false } merge with AND, so the
		// non-ignoring caller wins and forceRedeploy is still honored.
		const merged = mergeDeployGitStackOpts(
			{ force: false, ignoreForceRedeploy: true },
			{ force: false, ignoreForceRedeploy: false }
		);

		assert.deepEqual(merged, { force: false, ignoreForceRedeploy: false });
		assert.equal(
			shouldDeployGitStack({
				force: merged.force,
				ignoreForceRedeploy: merged.ignoreForceRedeploy,
				forceRedeploy: true,
				updated: false
			}),
			true
		);
	});

	it('skips stacks that never opted into any redeploy behaviour', async () => {
		const stacks: TestStack[] = [
			{ id: 1, stackName: 'passive', forceRedeploy: false, webhookEnabled: false, updated: false }
		];

		const result = await fanOutDeployStacks(stacks, (stackId, opts) => {
			const stack = stacks.find((s) => s.id === stackId)!;
			return Promise.resolve(coreDeploy(opts, stack));
		});

		assert.deepEqual(
			result.stacks.map((s) => [s.id, s.status]),
			[[1, 'skipped']]
		);
		assert.equal(result.success, true);
	});

	it('continues fan-out and reports failure when one stack fails', async () => {
		const stacks: TestStack[] = [
			{ id: 1, stackName: 'plain-force', forceRedeploy: true, webhookEnabled: false, updated: true },
			{ id: 2, stackName: 'broken', forceRedeploy: false, webhookEnabled: false, updated: false }
		];

		const result = await fanOutDeployStacks(stacks, (stackId) => {
			if (stackId === 2) return Promise.resolve({ success: false, error: 'compose failed' });
			const stack = stacks.find((s) => s.id === stackId)!;
			return Promise.resolve(coreDeploy({ force: false, ignoreForceRedeploy: false }, stack));
		});

		assert.deepEqual(
			result.stacks.map((s) => [s.id, s.status]),
			[[1, 'deployed'], [2, 'failed']]
		);
		assert.equal(result.success, false);
		assert.match(result.error ?? '', /failed/i);
	});

	it('marks a stack failed and continues when its deploy exceeds the per-stack timeout', async () => {
		const stacks: TestStack[] = [
			{ id: 1, stackName: 'stuck', forceRedeploy: true, webhookEnabled: false, updated: true },
			{ id: 2, stackName: 'fast', forceRedeploy: false, webhookEnabled: false, updated: true }
		];

		const calls: number[] = [];
		const result = await fanOutDeployStacks(
			stacks,
			(stackId) => {
				calls.push(stackId);
				if (stackId === 1) return new Promise(() => {}); // never resolves
				const stack = stacks.find((s) => s.id === stackId)!;
				return Promise.resolve(coreDeploy({ force: false, ignoreForceRedeploy: false }, stack));
			},
			undefined,
			20
		);

		// The stuck stack did not stall the fan-out — the next stack still ran.
		assert.deepEqual(calls, [1, 2]);
		assert.deepEqual(result.stacks.map((s) => [s.id, s.status]), [[1, 'failed'], [2, 'deployed']]);
		const stuck = result.stacks.find((s) => s.id === 1);
		assert.equal(stuck?.status, 'failed');
		if (stuck?.status === 'failed') assert.match(stuck.error ?? '', /timed out/i);
		assert.equal(result.success, false);
	});

	it('succeeds with no stacks', async () => {
		const result = await fanOutDeployStacks([], () => Promise.resolve({ success: true }));

		assert.equal(result.success, true);
		assert.deepEqual(result.stacks, []);
	});
});

describe('env-scoped fan-out filtering (filterStacksByEnvAccess)', () => {
	const stacks = [
		{ id: 1, environmentId: 10 },
		{ id: 2, environmentId: 20 },
		{ id: 3, environmentId: null }
	];

	it('keeps only stacks whose environment the caller can deploy', async () => {
		const allowed = await filterStacksByEnvAccess(stacks, async (envId) => envId === 10 || envId === null);
		assert.deepEqual(allowed, [1, 3]);
	});

	it('resolves global stacks against the global permission', async () => {
		const allowed = await filterStacksByEnvAccess(stacks, async () => true);
		assert.deepEqual(allowed, [1, 2, 3]);
	});

	it('returns 403-eligible empty set when no environment is accessible', async () => {
		const allowed = await filterStacksByEnvAccess(stacks, async () => false);
		assert.deepEqual(allowed, []);
	});
});

describe('mergeFanOutStackIds (coalesced repo deploys)', () => {
	it('unions two callers filters so neither loses authorized stacks', () => {
		assert.deepEqual(mergeFanOutStackIds([1, 2], [2, 3]), [1, 2, 3]);
	});

	it('an undefined filter means deploy-all and wins the merge', () => {
		assert.deepEqual(mergeFanOutStackIds([1], undefined), undefined);
		assert.deepEqual(mergeFanOutStackIds(undefined, [1]), undefined);
	});
});
