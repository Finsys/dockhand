import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildComposeOperationArgs, shouldRunSeparateBuildStep, deployPullPolicy, pullSteps, pullThenUp, PULL_FAILED_WARNING } from '../src/lib/server/compose-args';

describe('buildComposeOperationArgs', () => {
	it('plain up: no --build, no --no-cache (back-compat, the common case)', () => {
		const a = buildComposeOperationArgs('up', {});
		expect(a).toEqual(['up', '-d', '--remove-orphans']);
	});

	it('up with build (no no-cache): keeps --build exactly as before', () => {
		const a = buildComposeOperationArgs('up', { build: true });
		expect(a).toContain('--build');
		expect(a).not.toContain('--no-cache');
	});

	it('up never carries --no-cache, even when noBuildCache is requested (#1479)', () => {
		const a = buildComposeOperationArgs('up', { build: true, noBuildCache: true });
		expect(a).not.toContain('--no-cache');
	});

	it('up omits --build when a no-cache rebuild is requested (the separate build step handles it)', () => {
		const a = buildComposeOperationArgs('up', { build: true, noBuildCache: true });
		expect(a).not.toContain('--build');
	});

	it('up passes forceRecreate, pull policy, and a target service', () => {
		const a = buildComposeOperationArgs('up', { forceRecreate: true, pullPolicy: 'always', serviceName: 'web' });
		expect(a).toEqual(['up', '-d', '--remove-orphans', '--force-recreate', '--pull', 'always', 'web']);
	});

	it('build operation carries --no-cache only when requested', () => {
		expect(buildComposeOperationArgs('build', { noBuildCache: true })).toEqual(['build', '--no-cache']);
		expect(buildComposeOperationArgs('build', { noBuildCache: false })).toEqual(['build']);
	});

	it('build operation scopes to a single service when given', () => {
		expect(buildComposeOperationArgs('build', { noBuildCache: true, serviceName: 'web' })).toEqual(['build', '--no-cache', 'web']);
	});

	it('down / stop / start / restart / pull unchanged (back-compat)', () => {
		expect(buildComposeOperationArgs('down', {})).toEqual(['down', '--remove-orphans']);
		expect(buildComposeOperationArgs('down', { removeVolumes: true })).toEqual(['down', '--remove-orphans', '--volumes']);
		expect(buildComposeOperationArgs('stop', {})).toEqual(['stop']);
		expect(buildComposeOperationArgs('start', {})).toEqual(['start']);
		expect(buildComposeOperationArgs('restart', {})).toEqual(['restart']);
		expect(buildComposeOperationArgs('pull', {})).toEqual(['pull']);
		expect(buildComposeOperationArgs('pull', { serviceName: 'web' })).toEqual(['pull', 'web']);
	});
});

describe('shouldRunSeparateBuildStep', () => {
	it('runs for local socket (no env) and direct when a no-cache rebuild is requested', () => {
		expect(shouldRunSeparateBuildStep(true, true, undefined)).toBe(true);
		expect(shouldRunSeparateBuildStep(true, true, 'socket')).toBe(true);
		expect(shouldRunSeparateBuildStep(true, true, 'direct')).toBe(true);
	});

	it('never runs for Hawser (its agent has no build op) - a no-cache request is a no-op there', () => {
		expect(shouldRunSeparateBuildStep(true, true, 'hawser-standard')).toBe(false);
		expect(shouldRunSeparateBuildStep(true, true, 'hawser-edge')).toBe(false);
	});

	it('does not run without both build and noBuildCache (back-compat: normal deploys unaffected)', () => {
		expect(shouldRunSeparateBuildStep(false, true, 'socket')).toBe(false);
		expect(shouldRunSeparateBuildStep(true, false, 'socket')).toBe(false);
		expect(shouldRunSeparateBuildStep(false, false, 'socket')).toBe(false);
		expect(shouldRunSeparateBuildStep(undefined, undefined, 'socket')).toBe(false);
	});
});

describe('deployPullPolicy', () => {
	it('pull alone forces every image with --pull always', () => {
		expect(deployPullPolicy(true, false)).toBe('always');
		expect(deployPullPolicy(true)).toBe('always');
	});
	it('pull with respect asks for the separate pull that honours pull_policy', () => {
		expect(deployPullPolicy(true, true)).toBe('respect');
	});
	it('no pull is no policy, whatever respect says', () => {
		expect(deployPullPolicy(false, true)).toBeUndefined();
		expect(deployPullPolicy(undefined, undefined)).toBeUndefined();
	});
});

describe('pullSteps', () => {
	// Measured on compose 5.1.2: `up --pull always` pulls a pull_policy: never/missing
	// image anyway, a plain `docker compose pull` skips it.
	it("'respect' pulls separately and starts without --pull", () => {
		const steps = pullSteps('respect');
		expect(steps).toEqual({ separatePull: true });
		expect(buildComposeOperationArgs('up', { pullPolicy: steps.upPullPolicy })).toEqual(['up', '-d', '--remove-orphans']);
	});
	it('any other policy goes to up unchanged', () => {
		expect(pullSteps('always')).toEqual({ separatePull: false, upPullPolicy: 'always' });
		expect(pullSteps(undefined)).toEqual({ separatePull: false, upPullPolicy: undefined });
	});
});

describe('pullThenUp', () => {
	function recorder(pullOk = true) {
		const calls: string[] = [];
		const warnings: string[] = [];
		const run = async (operation: 'pull' | 'up', upPullPolicy?: string) => {
			calls.push(upPullPolicy ? `${operation} --pull ${upPullPolicy}` : operation);
			return { success: operation === 'pull' ? pullOk : true, operation };
		};
		return { calls, warnings, run, warn: (m: string) => warnings.push(m) };
	}

	it("'respect' pulls first, then starts without --pull", async () => {
		const r = recorder();
		const result = await pullThenUp('respect', r.run, r.warn);
		expect(r.calls).toEqual(['pull', 'up']);
		expect(r.warnings).toEqual([]);
		expect(result.operation).toBe('up');
	});

	it('a failed pull is a warning and the stack still starts', async () => {
		const r = recorder(false);
		const result = await pullThenUp('respect', r.run, r.warn);
		expect(r.calls).toEqual(['pull', 'up']);
		expect(r.warnings).toEqual([PULL_FAILED_WARNING]);
		expect(result).toEqual({ success: true, operation: 'up' });
	});

	it("'always' and no policy run only up, as before", async () => {
		const a = recorder();
		await pullThenUp('always', a.run, a.warn);
		expect(a.calls).toEqual(['up --pull always']);
		const n = recorder();
		await pullThenUp(undefined, n.run, n.warn);
		expect(n.calls).toEqual(['up']);
	});
});

// stacks.ts and the deploy route load the database, which bun cannot, so these only pin
// that the policy is spelled through; pullThenUp itself is tested above and the
// sequence was run against a live daemon.
describe('the deploy paths hand the policy on', () => {
	const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

	it('deployStack runs pull and up through pullThenUp with the policy it was given', () => {
		const src = read('../src/lib/server/stacks.ts');
		expect(src).toMatch(/pullThenUp\(\s*pullPolicy,/);
		expect(src).toContain('{ ...cmdOptions, pullPolicy: upPullPolicy }');
	});

	it('the deploy route reads respectPullPolicy and passes it on', () => {
		const src = read('../src/routes/api/stacks/[name]/deploy/+server.ts');
		expect(src).toMatch(/const \{ pull, respectPullPolicy, build, forceRecreate \} = body/);
		expect(src).toMatch(/pullPolicy:\s*deployPullPolicy\(pull,\s*respectPullPolicy\)/);
	});
});
