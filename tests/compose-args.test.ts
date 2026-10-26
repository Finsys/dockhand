import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildComposeOperationArgs, runsSeparateBuild, deployPullPolicy, pullSteps, pullThenUp, PULL_FAILED_WARNING, runBuildStep, pullBuildThenUp, stepOptions, BUILD_STEP_UNSUPPORTED_WARNING } from '../src/lib/server/compose-args';
import type { DeletionApplyResult } from '../src/lib/server/git-deletions';

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

	// The two ups a no-cache deploy sends (stepOptions): after its build, and after an old
	// agent refused the build.
	it('a no-cache deploy starts with --no-build after its build, and with --build when the build step was refused', () => {
		const base = { build: true, noBuildCache: true, pullPolicy: 'always' };
		expect(buildComposeOperationArgs('up', stepOptions(base, { noBuild: true, noBuildCache: false }))).toEqual(['up', '-d', '--remove-orphans', '--no-build']);
		expect(buildComposeOperationArgs('up', stepOptions(base, { noBuild: false, noBuildCache: false }))).toEqual(['up', '-d', '--remove-orphans', '--build']);
	});

	it('up passes forceRecreate, pull policy, and a target service', () => {
		const a = buildComposeOperationArgs('up', { forceRecreate: true, pullPolicy: 'always', serviceName: 'web' });
		expect(a).toEqual(['up', '-d', '--remove-orphans', '--force-recreate', '--pull', 'always', 'web']);
	});

	it('build operation carries --no-cache only when requested', () => {
		expect(buildComposeOperationArgs('build', { noBuildCache: true })).toEqual(['build', '--no-cache']);
		expect(buildComposeOperationArgs('build', { noBuildCache: false })).toEqual(['build']);
	});

	// Measured on compose 5.1.3: only `build --pull` refreshes a Dockerfile's FROM image;
	// `up --build` and `compose pull` both leave the cached base in place.
	it('build operation pulls base images only when asked, in the order the Hawser agent uses', () => {
		expect(buildComposeOperationArgs('build', { pullBase: true })).toEqual(['build', '--pull']);
		expect(buildComposeOperationArgs('build', { pullBase: true, noBuildCache: true })).toEqual(['build', '--pull', '--no-cache']);
		expect(buildComposeOperationArgs('build', {})).toEqual(['build']);
	});

	it('pullBase never reaches up, which has its own --pull for service images', () => {
		expect(buildComposeOperationArgs('up', { build: true, pullBase: true })).toEqual(['up', '-d', '--remove-orphans', '--build']);
	});

	it('noBuild starts without building, and wins over build', () => {
		expect(buildComposeOperationArgs('up', { noBuild: true })).toEqual(['up', '-d', '--remove-orphans', '--no-build']);
		expect(buildComposeOperationArgs('up', { build: true, noBuild: true, pullPolicy: 'always' })).toEqual(['up', '-d', '--remove-orphans', '--no-build', '--pull', 'always']);
		expect(buildComposeOperationArgs('build', { noBuild: true })).toEqual(['build']);
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

	it("pull forces every image only for the 'always' policy", () => {
		expect(buildComposeOperationArgs('pull', { pullPolicy: 'always' })).toEqual(['pull', '--policy', 'always']);
		expect(buildComposeOperationArgs('pull', { pullPolicy: 'missing' })).toEqual(['pull']);
		expect(buildComposeOperationArgs('pull', { pullPolicy: 'always', serviceName: 'web' })).toEqual(['pull', '--policy', 'always', 'web']);
	});

	it('the pull before a base-image build skips buildable services', () => {
		expect(buildComposeOperationArgs('pull', { pullPolicy: 'always', pullBase: true })).toEqual(['pull', '--policy', 'always', '--ignore-buildable']);
		expect(buildComposeOperationArgs('pull', { pullBase: true })).toEqual(['pull', '--ignore-buildable']);
	});

	// Measured on compose 5.1.2: pulling a buildable service whose tag is in no registry exits 1.
	it('the pull before a no-cache build skips buildable services', () => {
		expect(buildComposeOperationArgs('pull', { pullPolicy: 'always', noBuildCache: true })).toEqual(['pull', '--policy', 'always', '--ignore-buildable']);
		expect(buildComposeOperationArgs('pull', { build: true })).toEqual(['pull']);
	});
});

describe('runsSeparateBuild', () => {
	it('builds separately for a base-image pull and for a no-cache rebuild, on every connection type', () => {
		expect(runsSeparateBuild(true, true, false)).toBe(true);
		expect(runsSeparateBuild(true, false, true)).toBe(true);
		expect(runsSeparateBuild(true, true, true)).toBe(true);
	});

	it('a plain build, or no build at all, stays in up', () => {
		expect(runsSeparateBuild(true, false, false)).toBe(false);
		expect(runsSeparateBuild(false, true, true)).toBe(false);
		expect(runsSeparateBuild(undefined, undefined, undefined)).toBe(false);
	});
});

// The commands a no-cache deploy with --pull always runs, end to end through the helpers.
// Measured on compose 5.1.2: this order leaves the fresh build running.
describe('a no-cache deploy', () => {
	it('pulls the other images, builds without cache, then starts without building', async () => {
		const base = { build: true, noBuildCache: true, pullBase: false, pullPolicy: 'always' };
		const commands: string[][] = [];
		await pullBuildThenUp(
			base.pullPolicy,
			async (operation, opts) => {
				commands.push(buildComposeOperationArgs(operation, stepOptions(base, opts)));
				return { success: true };
			},
			() => {}
		);
		expect(commands).toEqual([
			['pull', '--policy', 'always', '--ignore-buildable'],
			['build', '--no-cache'],
			['up', '-d', '--remove-orphans', '--no-build']
		]);
	});
});

describe('runBuildStep', () => {
	function collect() {
		const warnings: string[] = [];
		return { warnings, warn: (m: string) => warnings.push(m) };
	}

	it('a successful build goes on to an up that does not build again', async () => {
		const c = collect();
		expect(await runBuildStep(async () => ({ success: true }), c.warn)).toEqual({ built: true });
		expect(c.warnings).toEqual([]);
	});

	it('a failed build stops the deploy with its own result', async () => {
		const c = collect();
		const failed = { success: false, error: 'failed to solve: process "/bin/sh -c make" did not complete successfully' };
		const step = await runBuildStep(async () => failed, c.warn);
		expect(step.stop).toBe(failed);
		expect(step.built).toBe(false);
		expect(c.warnings).toEqual([]);
	});

	// The error a Hawser agent before 0.2.51 returns for operation "build", over HTTP
	// (result.error) and over edge (wrapped by the transport).
	it('an agent without the build operation is a warning and the deploy goes on', async () => {
		for (const error of ['unsupported compose operation: build', 'Failed to build via Hawser: unsupported compose operation: build']) {
			const c = collect();
			// built:false keeps up's --build, the only build an old agent can do.
			expect(await runBuildStep(async () => ({ success: false, error }), c.warn)).toEqual({ built: false });
			expect(c.warnings).toEqual([BUILD_STEP_UNSUPPORTED_WARNING]);
		}
	});

	it('a build error that only mentions compose still stops the deploy', async () => {
		const c = collect();
		const failed = { success: false, error: 'unsupported compose file version' };
		expect((await runBuildStep(async () => failed, c.warn)).stop).toBe(failed);
	});
});

describe('pullBuildThenUp', () => {
	type Op = 'pull' | 'build' | 'up';
	function recorder(outcome: Partial<Record<Op, { success: boolean; error?: string }>> = {}) {
		const calls: string[] = [];
		const warnings: string[] = [];
		const run = async (operation: Op, opts: { pullPolicy?: string; noBuild?: boolean }) => {
			calls.push([operation, opts.pullPolicy && `policy=${opts.pullPolicy}`, opts.noBuild && 'no-build'].filter(Boolean).join(' '));
			return { ...(outcome[operation] ?? { success: true }), operation };
		};
		return { calls, warnings, run, warn: (m: string) => warnings.push(m) };
	}

	it("'always' pulls every image first, then builds, then starts without building or pulling", async () => {
		const r = recorder();
		const result = await pullBuildThenUp('always', r.run, r.warn);
		expect(r.calls).toEqual(['pull policy=always', 'build', 'up no-build']);
		expect(result.operation).toBe('up');
	});

	it("'respect' pulls by each service's pull_policy before the build", async () => {
		const r = recorder();
		await pullBuildThenUp('respect', r.run, r.warn);
		expect(r.calls).toEqual(['pull', 'build', 'up no-build']);
	});

	it('no pull policy skips the pull', async () => {
		const r = recorder();
		await pullBuildThenUp(undefined, r.run, r.warn);
		expect(r.calls).toEqual(['build', 'up no-build']);
	});

	it('a failed pull is a warning; the build and up still run', async () => {
		const r = recorder({ pull: { success: false, error: 'pull access denied for app' } });
		const result = await pullBuildThenUp('always', r.run, r.warn);
		expect(r.calls).toEqual(['pull policy=always', 'build', 'up no-build']);
		expect(r.warnings).toEqual([PULL_FAILED_WARNING]);
		expect(result.success).toBe(true);
	});

	it('a failed build stops before up and is the result', async () => {
		const r = recorder({ build: { success: false, error: 'failed to solve' } });
		const result = await pullBuildThenUp('always', r.run, r.warn);
		expect(r.calls).toEqual(['pull policy=always', 'build']);
		expect(result).toEqual({ success: false, error: 'failed to solve', operation: 'build' });
	});

	it('up is never asked for noBuildCache, so an old agent does not run up --no-cache', async () => {
		const opts: Record<string, unknown>[] = [];
		await pullBuildThenUp(undefined, async (operation, o) => {
			if (operation === 'up') opts.push(o);
			return operation === 'build' ? { success: false, error: 'unsupported compose operation: build' } : { success: true };
		}, () => {});
		expect(opts).toEqual([{ noBuild: false, noBuildCache: false }]);
		const base = { build: true, noBuildCache: true };
		expect(stepOptions(base, opts[0]).noBuildCache).toBe(false);
	});

	it('an agent without the build operation warns, and up builds the only way it can', async () => {
		const r = recorder({ build: { success: false, error: 'Compose error: unsupported compose operation: build' } });
		const result = await pullBuildThenUp(undefined, r.run, r.warn);
		expect(r.calls).toEqual(['build', 'up']);
		expect(r.warnings).toEqual([BUILD_STEP_UNSUPPORTED_WARNING]);
		expect(result.success).toBe(true);
	});
});

// Each step reports the file deletions it was sent. Agent 0.2.51/0.2.52 delete on up only and
// do not answer for a build; 0.2.53 deletes on the build, so its up finds the file gone.
describe('pullBuildThenUp reports the deletions of build and up together', () => {
	type Step = { success: boolean; error?: string; deletion?: DeletionApplyResult };
	const run = (build: Partial<Step>, up: Partial<Step>) => async (operation: 'pull' | 'build' | 'up'): Promise<Step> =>
		({ success: true, ...(operation === 'build' ? build : operation === 'up' ? up : {}) });

	it('an agent that deletes on up', async () => {
		const result = await pullBuildThenUp(undefined, run({}, { deletion: { deleted: ['old.conf'], skipped: [] } }), () => {});
		expect(result.deletion).toEqual({ deleted: ['old.conf'], skipped: [] });
	});

	it('a file in both reports is listed once', async () => {
		const result = await pullBuildThenUp(undefined, run(
			{ deletion: { deleted: ['old.conf'], skipped: [] } },
			{ deletion: { deleted: ['old.conf'], skipped: [] } }
		), () => {});
		expect(result.deletion).toEqual({ deleted: ['old.conf'], skipped: [] });
	});

	it('an agent that deletes on the build', async () => {
		const result = await pullBuildThenUp(undefined, run(
			{ deletion: { deleted: ['old.conf'], skipped: [] } },
			{ deletion: { deleted: [], skipped: [{ path: 'old.conf', reason: 'already-absent' }] } }
		), () => {});
		expect(result.deletion).toEqual({ deleted: ['old.conf'], skipped: [] });
	});

	it('a file no step deleted keeps the last step\'s reason', async () => {
		const result = await pullBuildThenUp(undefined, run(
			{ deletion: { deleted: [], skipped: [{ path: 'edited.conf', reason: 'agent-no-support' }] } },
			{ deletion: { deleted: [], skipped: [{ path: 'edited.conf', reason: 'locally-modified' }] } }
		), () => {});
		expect(result.deletion).toEqual({ deleted: [], skipped: [{ path: 'edited.conf', reason: 'locally-modified' }] });
	});

	it('no deletions sent, no report', async () => {
		const result = await pullBuildThenUp(undefined, run({}, {}), () => {});
		expect(result).toEqual({ success: true });
	});

	it('a failed build is the result, with its own report', async () => {
		const result = await pullBuildThenUp(undefined, run(
			{ success: false, error: 'failed to solve', deletion: { deleted: ['old.conf'], skipped: [] } },
			{ deletion: { deleted: [], skipped: [] } }
		), () => {});
		expect(result).toEqual({ success: false, error: 'failed to solve', deletion: { deleted: ['old.conf'], skipped: [] } });
	});
});

describe('stepOptions', () => {
	const base = { stackName: 's', build: true, pullBase: true, pullPolicy: 'respect', forceRecreate: true };

	it('a step runs with its own pull policy, the rest unchanged', () => {
		expect(stepOptions(base, { pullPolicy: 'always' })).toEqual({ ...base, pullPolicy: 'always' });
		expect(stepOptions(base, {})).toEqual({ ...base, pullPolicy: undefined });
	});

	it('an up after a successful build neither builds nor pulls', () => {
		expect(stepOptions(base, { noBuild: true })).toEqual({ ...base, pullPolicy: undefined, build: false, noBuild: true });
		expect(buildComposeOperationArgs('up', stepOptions(base, { noBuild: true }))).toEqual(['up', '-d', '--remove-orphans', '--force-recreate', '--no-build']);
	});

	it('an up after an old agent refused the build keeps --build', () => {
		expect(buildComposeOperationArgs('up', stepOptions(base, { noBuild: false }))).toEqual(['up', '-d', '--remove-orphans', '--force-recreate', '--build']);
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
		expect(src).toMatch(/const \{ pull, respectPullPolicy, build, pullBase, forceRecreate \} = body/);
		expect(src).toMatch(/pullPolicy:\s*deployPullPolicy\(pull,\s*respectPullPolicy\)/);
		expect(src).toMatch(/pullBase:\s*!!pullBase/);
	});

	it('deployStack runs a separate build through pullBuildThenUp with stepOptions', () => {
		const src = read('../src/lib/server/stacks.ts');
		expect(src).toMatch(/const result = runsSeparateBuild\(build, pullBase, noBuildCache\)\s*\?\s*await pullBuildThenUp\(\s*pullPolicy,/);
		expect(src).toContain('executeComposeCommand(operation, stepOptions(cmdOptions, opts), compose, composeEnvVars, secretVars, onLine)');
		expect(src).toContain('pullBase: build && pullBase,');
		expect(src).toMatch(/pullBase: pullBase \|\| false/);
		expect(src).toContain("if (operation === 'up' || operation === 'pull' || operation === 'build') {");
	});
});
