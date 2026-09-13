import { describe, it, expect } from 'bun:test';
import { runRedeployStack, type RedeployStackSteps } from '../../src/lib/server/backups/redeploy-stack-core';

// Records the order steps run in, so we can assert register-before-deploy.
function recorder(overrides: Partial<RedeployStackSteps> = {}) {
	const calls: string[] = [];
	const steps: RedeployStackSteps = {
		restoreSecrets: async () => { calls.push('restoreSecrets'); },
		materialise: async () => { calls.push('materialise'); return true; },
		register: async () => { calls.push('register'); },
		deploy: async () => { calls.push('deploy'); },
		...overrides
	};
	return { calls, steps };
}

describe('runRedeployStack — step order', () => {
	it('runs restoreSecrets -> materialise -> register -> deploy in that order', async () => {
		const { calls, steps } = recorder();
		await runRedeployStack(steps);
		expect(calls).toEqual(['restoreSecrets', 'materialise', 'register', 'deploy']);
	});

	it('registers the stack BEFORE deploying (register precedes deploy)', async () => {
		const { calls, steps } = recorder();
		await runRedeployStack(steps);
		expect(calls.indexOf('register')).toBeLessThan(calls.indexOf('deploy'));
	});

	it('still registers even when deploy fails - the stack survives as editable/internal', async () => {
		const { calls, steps } = recorder({
			deploy: async () => { calls.push('deploy'); throw new Error('docker compose up failed'); }
		});
		await expect(runRedeployStack(steps)).rejects.toThrow('docker compose up failed');
		// register ran (before the throw); this is the whole fix - a failed deploy does not
		// cost the user their managed stack.
		expect(calls).toContain('register');
		expect(calls.indexOf('register')).toBeLessThan(calls.indexOf('deploy'));
	});

	it('hard-errors and does NOT register when materialise reports no files landed', async () => {
		const { calls, steps } = recorder({ materialise: async () => { calls.push('materialise'); return false; } });
		await expect(runRedeployStack(steps)).rejects.toThrow('could not materialise');
		expect(calls).not.toContain('register');
		expect(calls).not.toContain('deploy');
	});

	it('propagates a materialise throw before registering', async () => {
		const { calls, steps } = recorder({ materialise: async () => { throw new Error('restic boom'); } });
		await expect(runRedeployStack(steps)).rejects.toThrow('restic boom');
		expect(calls).not.toContain('register');
	});
});
