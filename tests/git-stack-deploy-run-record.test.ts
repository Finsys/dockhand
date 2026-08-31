/**
 * Wires the stack_deploy run recorder into `deployGitStack()` (git.ts) itself, not
 * into any single HTTP route. deployGitStack is the one function EVERY git-stack
 * deploy trigger funnels through -- the manual "Deploy" button, a config-update-
 * then-redeploy, both webhook methods, create-and-deploy, and (via
 * runGitStackSync) the cron scheduler and the schedules page's "run now". Wiring
 * the recorder at a single route (the way compose/+server.ts does it for non-git
 * stacks) would leave every OTHER caller unrecorded -- crucially the cron- and
 * webhook-triggered ones, the truly unattended runs the design doc's Meilenstein 5
 * is about.
 *
 * `syncGitStack()` (also in git.ts) is a private collaborator of deployGitStack,
 * called as a plain in-module function reference, not through an imported
 * specifier -- so unlike the non-git deploy routes' $lib/server/stacks dependency,
 * it CANNOT be faked via mock.module(). This suite therefore drives a REAL git
 * sync against a throwaway local repository served over `git://` by a real `git
 * daemon` subprocess (loopback only, ephemeral port) -- a bare filesystem path or
 * `file://` URL is deliberately rejected by git-url-safety.ts (SSRF guard) and
 * this test does not, and should not, work around that. Only the boundary below
 * deployGitStack -- $lib/server/stacks' deployStack() -- is faked, exactly the
 * boundary the compose-PUT/dedicated-deploy-route tests already fake for the
 * same reason (no real `docker compose` in a unit test).
 *
 * $lib/server/db and $lib/server/stacks are faked via the shared helpers -- see
 * their doc comments for why a second direct mock.module() call for either would
 * collide with other files that already own those specifiers for this process.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { registerDbFake } from './helpers/db-fake';
import { registerStacksFake } from './helpers/stacks-fake';

// notifyGitSync (git.ts) wraps sendEventNotification in its own try/catch and never
// lets it affect the deploy outcome, so a no-op stub is all this suite needs -- and
// all it should assert on; which notification fired for which trigger belongs to a
// test of notifyGitSync itself, not this one. No other file in the suite mocks this
// specifier (as of this writing), so a single direct mock.module() call here is safe
// -- see tests/helpers/stacks-fake.ts's doc comment for why db/stacks can't do the same.
mock.module('$lib/server/notifications', () => ({
	sendEventNotification: async () => {}
}));

// -- $lib/server/db: an in-memory schedule_executions fake, plus the git-stack -----
// -- lookups deployGitStack/syncGitStack need. Same shape as
// tests/stack-compose-redeploy-run-record.test.ts's fake for the schedule_executions
// half; the git-specific reads/writes below are new to this file.

let created: Array<Record<string, unknown>>;
let updates: Array<Record<string, unknown>>;
let nextId: number;
let gitStackUpdates: Array<Record<string, unknown>>;
let upsertedSources: Array<Record<string, unknown>>;

function resetDbState() {
	created = [];
	updates = [];
	nextId = 1;
	gitStackUpdates = [];
	upsertedSources = [];
}
resetDbState();

registerDbFake('createScheduleExecution', async (data: Record<string, unknown>) => {
	const row = {
		id: nextId++,
		...data,
		triggeredAt: new Date().toISOString(),
		startedAt: null,
		completedAt: null,
		duration: null,
		errorMessage: null,
		details: data.details ?? null,
		logs: null,
		createdAt: null
	};
	created.push(row);
	return row;
});
registerDbFake('updateScheduleExecution', async (id: number, data: Record<string, unknown>) => {
	updates.push({ id, ...data });
	return { id, ...data };
});

/** The update() call that CLOSED the row (status !== 'running'), i.e. the one written
 *  by DeployRunRecorder.end() -- same helper shape as the compose-redeploy suite's
 *  endUpdate(). Only ever at most one per test: every case here deploys exactly once. */
function endUpdate() {
	return updates.find((u) => u.status !== undefined);
}

/** All stack_deploy rows created for THIS suite's stack, as opposed to the
 *  git_stack_sync bookkeeping row a caller like git-stack-sync.ts creates separately
 *  (a different scheduleType, not exercised by this file -- this suite calls
 *  deployGitStack directly, the layer below that bookkeeping). */
function stackDeployRows() {
	return created.filter((r) => r.scheduleType === 'stack_deploy');
}

let nonSecretVars: Record<string, string>;
let secretVars: Record<string, string>;

registerDbFake('getSecretEnvVarsAsRecord', async () => secretVars);
registerDbFake('getNonSecretEnvVarsAsRecord', async () => nonSecretVars);
registerDbFake('updateGitStack', async (id: number, data: Record<string, unknown>) => {
	gitStackUpdates.push({ id, ...data });
	return null;
});
registerDbFake('upsertStackSource', async (data: Record<string, unknown>) => {
	upsertedSources.push(data);
});

// -- $lib/server/stacks: only deployStack (and getStackDir, used for the post-
// -- success stack_sources bookkeeping) are faked -- everything ABOVE that
// -- boundary (deployGitStack, syncGitStack) runs for real.

let deployStackCalls: Array<{ onLine?: (line: string) => void }>;
let deployStackResult: { success: boolean; output?: string; error?: string; resolvedSecrets?: string[] };
let deployStackOnLines: string[];

function resetStacksState() {
	deployStackCalls = [];
	deployStackResult = { success: true, output: 'deployed' };
	deployStackOnLines = ['Container demo-stack-app-1  Started'];
}
resetStacksState();

registerStacksFake('deployStack', async (options: { onLine?: (line: string) => void }) => {
	deployStackCalls.push(options);
	for (const line of deployStackOnLines) options.onLine?.(line);
	return deployStackResult;
});
registerStacksFake('getStackDir', async (stackName: string) => join('/tmp/stub-stacks', stackName));

// -- A real local git remote, served over git:// by a real `git daemon` -----------
//
// DATA_DIR is process-global and read at IMPORT time by git.ts (GIT_REPOS_DIR) and
// at call time by deploy-log-store.ts -- same precaution tests/deploy-endpoints.test.ts
// and the compose-redeploy suite already document for this shared env var.

const previousDataDir = process.env.DATA_DIR;
let workDir: string;
let daemon: ChildProcess;
let daemonPort: number;
const STACK = 'demo-git-stack';

function run(cmd: string, args: string[], cwd: string): void {
	const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
	if (result.status !== 0) {
		throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr}`);
	}
}

/** Waits for the daemon to actually accept connections (spawn is async) by polling
 *  a real `git ls-remote` against it, rather than a fixed sleep. */
async function waitForDaemon(port: number, deadlineMs: number): Promise<void> {
	const start = Date.now();
	let lastError: string | undefined;
	while (Date.now() - start < deadlineMs) {
		const probe = spawnSync('git', ['ls-remote', `git://127.0.0.1:${port}/remote.git`], {
			encoding: 'utf8',
			timeout: 2000
		});
		if (probe.status === 0) return;
		lastError = probe.stderr;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`git daemon on port ${port} never became ready: ${lastError}`);
}

beforeAll(async () => {
	workDir = await mkdtemp(join(tmpdir(), 'dv-git-deploy-run-record-'));
	process.env.DATA_DIR = workDir;

	// Seed the bare "remote" repo with one commit on main, containing a compose file
	// at the repo-relative path the fixture GitStackWithRepo below points at.
	const bareDir = join(workDir, 'remote.git');
	const scratchDir = join(workDir, 'scratch');
	await mkdir(bareDir, { recursive: true });
	run('git', ['init', '--bare', '-b', 'main', bareDir], workDir);
	run('git', ['clone', bareDir, scratchDir], workDir);
	run('git', ['config', 'user.email', 'test@example.invalid'], scratchDir);
	run('git', ['config', 'user.name', 'Test'], scratchDir);
	await writeFile(join(scratchDir, 'compose.yaml'), 'services:\n  app:\n    image: demo:1\n');
	run('git', ['add', 'compose.yaml'], scratchDir);
	run('git', ['commit', '-m', 'initial'], scratchDir);
	run('git', ['push', 'origin', 'main'], scratchDir);

	daemonPort = 20000 + Math.floor(Math.random() * 20000);
	daemon = spawn(
		'git',
		[
			'daemon',
			'--reuseaddr',
			'--export-all',
			`--base-path=${workDir}`,
			`--port=${daemonPort}`,
			'--listen=127.0.0.1'
		],
		{ stdio: 'ignore' }
	);
	await waitForDaemon(daemonPort, 5000);
}, 15000);

afterAll(async () => {
	daemon?.kill();
	await rm(workDir, { recursive: true, force: true });
	if (previousDataDir === undefined) {
		delete process.env.DATA_DIR;
	} else {
		process.env.DATA_DIR = previousDataDir;
	}
});

// -- Route/function under test, imported AFTER DATA_DIR is set and all fakes are ---
// -- registered (git.ts reads DATA_DIR at module-load time for GIT_REPOS_DIR).

const { deployGitStack } = await import('../src/lib/server/git');
const { readRunLog, deleteRunLog } = await import('../src/lib/server/deploy-log-store');
const { hashComposeContent } = await import('../src/lib/server/deploy-run-record-core');

let gitStackId: number;

function repoUrl(): string {
	return `git://127.0.0.1:${daemonPort}/remote.git`;
}

function makeGitStack(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: gitStackId,
		stackName: STACK,
		environmentId: null,
		repositoryId: 1,
		composePath: 'compose.yaml',
		branch: null,
		envFilePath: null,
		autoUpdate: false,
		autoUpdateSchedule: 'daily' as const,
		autoUpdateCron: '',
		webhookEnabled: false,
		webhookSecret: null,
		contextDir: null,
		buildOnDeploy: false,
		noBuildCache: false,
		repullImages: false,
		forceRedeploy: false,
		lastSync: null,
		lastCommit: null,
		syncStatus: 'idle',
		syncError: null,
		syncedFiles: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		repository: {
			id: 1,
			name: 'test-repo',
			url: repoUrl(),
			branch: 'main',
			credentialId: null
		},
		...overrides
	};
}

let nextGitStackId = 1;

beforeEach(async () => {
	resetDbState();
	resetStacksState();
	// A fresh, never-before-used stack id per test -- getStackRepoPath() derives the
	// on-disk clone path from it (stack-<id>, since environmentId is null), so this
	// also gives every test its own clone directory. Without this, a later test could
	// inherit an earlier test's already-cloned repo at the SAME commit and silently
	// take the "no changes" skip path instead of the deploy path it meant to test.
	gitStackId = nextGitStackId++;
	nonSecretVars = { PUBLIC_VAR: 'v1' };
	secretVars = { DB_PASSWORD: 's3cr3t-value' };

	registerDbFake('getGitStack', async () => makeGitStack());
	registerDbFake('getGitRepository', async () => makeGitStack().repository);

	// nextId always restarts at 1 above, so every test's (at most one) row reuses
	// runId '1' -- clear its log file so tests don't leak content into each other via
	// the shared DATA_DIR (same precaution the compose-redeploy suite documents).
	await deleteRunLog(null, '1');
});

describe('deployGitStack -- stack_deploy run record (git-triggered deploys)', () => {
	test('a manual-triggered deploy creates exactly one stack_deploy row, closed as success, with a readable log', async () => {
		const result = await deployGitStack(gitStackId, { triggeredBy: 'manual', force: true });

		expect(result.success).toBe(true);
		expect(deployStackCalls).toHaveLength(1); // the sync->deploy path really ran

		const rows = stackDeployRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].entityName).toBe(STACK);
		expect(rows[0].triggeredBy).toBe('manual');
		expect(rows[0].scheduleId).toBe(0);

		const update = endUpdate();
		expect(update?.status).toBe('success');
		expect(update?.errorMessage).toBeNull();

		const runId = String(rows[0].id);
		const log = await readRunLog(null, runId);
		expect(log).toContain('Container demo-stack-app-1  Started');
	});

	test('composeHash matches the content actually synced from the git repository', async () => {
		await deployGitStack(gitStackId, { triggeredBy: 'manual', force: true });

		const update = endUpdate();
		const details = update?.details as { composeHash: string };
		expect(details.composeHash).toBe(hashComposeContent('services:\n  app:\n    image: demo:1\n'));
	});

	test('a cron-triggered deploy (the unattended case this wiring exists for) is recorded with triggeredBy=cron', async () => {
		await deployGitStack(gitStackId, { triggeredBy: 'cron', force: false });

		const rows = stackDeployRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].triggeredBy).toBe('cron');
	});

	test('a webhook-triggered deploy is recorded with triggeredBy=webhook and no userId', async () => {
		await deployGitStack(gitStackId, { triggeredBy: 'webhook', force: false });

		const rows = stackDeployRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].triggeredBy).toBe('webhook');
		const update = endUpdate();
		const details = update?.details as { userId?: number };
		expect(details.userId).toBeUndefined();
	});

	test('a secret value in the deploy error text is redacted before it is stored', async () => {
		deployStackResult = { success: false, error: 'compose up failed: DB_PASSWORD=s3cr3t-value rejected' };
		deployStackOnLines = [];

		const result = await deployGitStack(gitStackId, { triggeredBy: 'manual', force: true });

		expect(result.success).toBe(false);
		const update = endUpdate();
		expect(update?.status).toBe('failed');
		expect(String(update?.errorMessage)).not.toContain('s3cr3t-value');
	});

	// F4 fix: deployStack() resolves a bound secret provider's values INTERNALLY,
	// after deployGitStack()'s `recorder` above was already built from the DB-only
	// nonSecretVars/secretVars this suite's fixture returns. A provider-resolved
	// secret (never in that DB-only set) is simulated via the fake's
	// resolvedSecrets -- exactly StackOperationResult's real shape -- and must still
	// be redacted from the stored error, via recorder.addSecrets(). This is the
	// unattended (cron/webhook) path deployGitStack's own doc comment calls out --
	// exactly where a bound secret provider is most likely to be in play unattended.
	test('F4 regression: a provider-resolved secret (unknown at recorder construction) is redacted before it is stored', async () => {
		const PROVIDER_SECRET = 'zzz-bulk-provider-9000';
		deployStackResult = {
			success: false,
			error: `compose up failed: PROVIDER_TOKEN=${PROVIDER_SECRET} rejected`,
			resolvedSecrets: [PROVIDER_SECRET]
		};
		deployStackOnLines = [];

		const result = await deployGitStack(gitStackId, { triggeredBy: 'cron', force: true });

		expect(result.success).toBe(false);
		const update = endUpdate();
		expect(update?.status).toBe('failed');
		expect(String(update?.errorMessage)).not.toContain(PROVIDER_SECRET);
	});

	test('a second, unchanged sync (force=false, nothing to deploy) creates NO additional stack_deploy row', async () => {
		// First call: the clone directory for this test's stack id does not exist yet,
		// so getPreviousCommit() (git.ts) returns null -> commitChanged is always true
		// on a first sync -> updated=true -> shouldDeploy=true even with force:false.
		// This deploys for real and records exactly one row, same as the tests above.
		const first = await deployGitStack(gitStackId, { triggeredBy: 'cron', force: false });
		expect(first.success).toBe(true);
		expect(first.skipped).toBeUndefined();
		expect(stackDeployRows()).toHaveLength(1);

		// Second call, same stack id, remote repository untouched in between:
		// syncGitStack reads the ACTUAL previous commit off the clone directory the
		// first call just left on disk (real git, not a fake), re-clones, and finds
		// the same commit -> commitChanged=false -> updated=false -> with force:false
		// and this fixture's forceRedeploy:false, shouldDeploy is false -> skip. The
		// recorder-creation block in git.ts sits AFTER that `if (!shouldDeploy) return`
		// branch, so a skip must create no new row at all.
		const second = await deployGitStack(gitStackId, { triggeredBy: 'cron', force: false });
		expect(second.success).toBe(true);
		expect(second.skipped).toBe(true);
		expect(deployStackCalls).toHaveLength(1); // still just the first call's deploy
		expect(stackDeployRows()).toHaveLength(1); // no row added for the skipped second call
	});
});

describe('deployGitStack -- Gegenprobe: removing the recorder wiring turns every test above red', () => {
	test('source-level guard: deployGitStack calls createRunRecorder exactly once', async () => {
		const { readFile } = await import('node:fs/promises');
		const { dirname } = await import('node:path');
		const { fileURLToPath } = await import('node:url');
		const here = dirname(fileURLToPath(import.meta.url));
		const source = await readFile(join(here, '..', 'src', 'lib', 'server', 'git.ts'), 'utf8');
		const matches = source.match(/createRunRecorder\(/g) ?? [];
		expect(matches).toHaveLength(1);
	});
});
