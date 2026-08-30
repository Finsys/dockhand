/**
 * deploy-run-view — pure text/label composition for the Stack modal's Deploys tab.
 * Import-free by design (see deploy-run-view.ts's doc comment) so it runs under Bun
 * without pulling in $lib/server (better-sqlite3, ERR_DLOPEN_FAILED).
 *
 * Run with: bun test tests/deploy-run-view.test.ts
 */
import { describe, test, expect } from 'bun:test';
import {
	formatStatusLabel,
	formatTrigger,
	formatRunDuration,
	formatContainerSummary,
	formatBuildStatus,
	formatOptionChips,
	lastErrorLine,
	buildDeployRunView,
	buildDeployLogPanelState,
	type DeployRun,
	type DeployRunSummary
} from '../src/lib/utils/deploy-run-view';

const summary = (over: Partial<DeployRunSummary> = {}): DeployRunSummary => ({
	containersCreated: 0,
	containersRecreated: 0,
	containersStarted: 0,
	imagesBuilt: [],
	imagesPulled: [],
	buildSteps: 0,
	buildStepsCached: 0,
	...over
});

const run = (over: Partial<DeployRun> = {}): DeployRun => ({
	id: 1,
	triggeredBy: 'manual',
	duration: 1500,
	status: 'success',
	errorMessage: null,
	details: { options: { pull: false, build: false, forceRecreate: false } },
	...over
});

describe('formatBuildStatus', () => {
	test('every build step came from cache', () => {
		expect(formatBuildStatus(summary({ buildSteps: 3, buildStepsCached: 3 }))).toBe(
			'Built from cache (3 steps)'
		);
	});

	test('a single cached step is not pluralized wrong', () => {
		expect(formatBuildStatus(summary({ buildSteps: 1, buildStepsCached: 1 }))).toBe(
			'Built from cache'
		);
	});

	test('partially built — some steps from cache, some not', () => {
		expect(formatBuildStatus(summary({ buildSteps: 4, buildStepsCached: 1 }))).toBe(
			'Built (4 steps, 1 from cache)'
		);
	});

	test('built with no cache hits at all', () => {
		expect(formatBuildStatus(summary({ buildSteps: 2, buildStepsCached: 0 }))).toBe(
			'Built (2 steps)'
		);
	});

	test('nothing built — a run that never touched the build step', () => {
		expect(formatBuildStatus(summary({ buildSteps: 0, buildStepsCached: 0 }))).toBe(
			'Nothing built'
		);
	});

	test('no summary at all reads as unknown, not as "nothing built"', () => {
		expect(formatBuildStatus(undefined)).toBe('Build status unknown');
	});
});

describe('formatContainerSummary', () => {
	test('no summary recorded says so explicitly — never "0 containers"', () => {
		const text = formatContainerSummary(undefined);
		expect(text).toBe('No summary recorded for this run');
		expect(text).not.toMatch(/0/);
	});

	test('a run with zero container changes reads distinctly from "no summary"', () => {
		expect(formatContainerSummary(summary())).toBe('No container changes');
	});

	test('created and started are joined, recreated omitted when zero', () => {
		expect(
			formatContainerSummary(summary({ containersCreated: 3, containersStarted: 1 }))
		).toBe('3 created, 1 started');
	});

	test('all three counts present appear in created, recreated, started order', () => {
		expect(
			formatContainerSummary(
				summary({ containersCreated: 1, containersRecreated: 2, containersStarted: 3 })
			)
		).toBe('1 created, 2 recreated, 3 started');
	});
});

describe('formatOptionChips', () => {
	test('no options recorded yields no chips', () => {
		expect(formatOptionChips(undefined)).toEqual([]);
	});

	test('all flags false yields no chips', () => {
		expect(formatOptionChips({ pull: false, build: false, forceRecreate: false })).toEqual([]);
	});

	test('every true flag becomes its own chip, in a fixed order', () => {
		expect(formatOptionChips({ pull: true, build: true, forceRecreate: true })).toEqual([
			'Pull',
			'Build',
			'Force recreate'
		]);
	});

	test('a single flag yields a single chip', () => {
		expect(formatOptionChips({ pull: true, build: false, forceRecreate: false })).toEqual(['Pull']);
	});
});

describe('formatTrigger', () => {
	test.each([
		['manual', 'Manual'],
		['cron', 'Scheduled'],
		['webhook', 'Webhook'],
		['startup', 'Startup']
	])('%s -> %s', (input, expected) => {
		expect(formatTrigger(input)).toBe(expected);
	});

	test('an unrecognized trigger value is not swallowed silently', () => {
		expect(formatTrigger('something-new')).toBe('something-new');
	});
});

describe('formatStatusLabel', () => {
	test.each([
		['success', 'Success'],
		['failed', 'Failed'],
		['running', 'Running']
	])('%s -> %s', (input, expected) => {
		expect(formatStatusLabel(input)).toBe(expected);
	});

	test('an unrecognized status value is passed through, not hidden', () => {
		expect(formatStatusLabel('mystery')).toBe('mystery');
	});
});

describe('formatRunDuration', () => {
	test('null/undefined duration (a run still in progress or never started)', () => {
		expect(formatRunDuration(null)).toBe('—');
		expect(formatRunDuration(undefined)).toBe('—');
	});

	test('sub-second durations render in milliseconds', () => {
		expect(formatRunDuration(340)).toBe('340ms');
	});

	test('sub-minute durations render with one decimal of seconds', () => {
		expect(formatRunDuration(13515)).toBe('13.5s');
	});

	test('minute-scale durations render as Nm Ns', () => {
		expect(formatRunDuration(125000)).toBe('2m 5s');
	});
});

describe('lastErrorLine', () => {
	test('no error message at all', () => {
		expect(lastErrorLine(null)).toBeNull();
		expect(lastErrorLine(undefined)).toBeNull();
		expect(lastErrorLine('')).toBeNull();
	});

	test('a short single-line message is returned unchanged', () => {
		expect(lastErrorLine('exit code 1')).toBe('exit code 1');
	});

	test('a multi-line message keeps only its last non-empty line', () => {
		const msg = 'Pulling image...\nBuilding...\nError: container failed to start\n';
		expect(lastErrorLine(msg)).toBe('Error: container failed to start');
	});

	test('a long single-line message is cut to maxLen with an ellipsis marker', () => {
		const long = 'x'.repeat(300);
		const result = lastErrorLine(long, 50);
		expect(result?.length).toBe(50);
		expect(result?.endsWith('…')).toBe(true);
		expect(result?.startsWith('x'.repeat(49))).toBe(true);
	});
});

describe('buildDeployRunView', () => {
	test('a run without a summary (no output at all) never claims to know container/build facts', () => {
		const view = buildDeployRunView(run({ details: { options: { pull: true, build: false, forceRecreate: false } } }));
		expect(view.containerSummary).toBe('No summary recorded for this run');
		expect(view.buildStatus).toBe('Build status unknown');
		expect(view.imagesBuilt).toEqual([]);
		expect(view.imagesPulled).toEqual([]);
	});

	test('truncated is surfaced only when the record actually says so', () => {
		expect(buildDeployRunView(run()).truncated).toBe(false);
		expect(
			buildDeployRunView(
				run({ details: { options: { pull: false, build: false, forceRecreate: false }, truncated: true } })
			).truncated
		).toBe(true);
	});

	test('a failed run with a long error message carries the shortened last line', () => {
		const longError = `Step 1 ok\nStep 2 ok\n${'boom '.repeat(60)}`;
		const view = buildDeployRunView(run({ status: 'failed', errorMessage: longError }));
		expect(view.errorSummary).not.toBeNull();
		expect(view.errorSummary!.length).toBeLessThanOrEqual(200);
		expect(view.statusLabel).toBe('Failed');
	});

	test('a successful run never surfaces an error summary even if errorMessage is set', () => {
		const view = buildDeployRunView(run({ status: 'success', errorMessage: 'leftover text' }));
		expect(view.errorSummary).toBeNull();
	});

	test('a running run in progress has no error summary and reads as Running', () => {
		const view = buildDeployRunView(run({ status: 'running', duration: null, errorMessage: null }));
		expect(view.errorSummary).toBeNull();
		expect(view.statusLabel).toBe('Running');
		expect(view.duration).toBe('—');
	});

	test('option chips and images pass through from the run summary', () => {
		const view = buildDeployRunView(
			run({
				details: {
					options: { pull: true, build: true, forceRecreate: false },
					summary: summary({ imagesBuilt: ['app:1'], imagesPulled: ['redis:7'] })
				}
			})
		);
		expect(view.optionChips).toEqual(['Pull', 'Build']);
		expect(view.imagesBuilt).toEqual(['app:1']);
		expect(view.imagesPulled).toEqual(['redis:7']);
	});
});

describe('buildDeployLogPanelState', () => {
	test('a normal completed run: log fetchable, not truncated, deletable', () => {
		const state = buildDeployLogPanelState(run({ status: 'success' }));
		expect(state).toEqual({ logMissing: false, truncated: false, deletable: true });
	});

	test('a run reconciled as logMissing short-circuits to logMissing -- regardless of truncated', () => {
		const state = buildDeployLogPanelState(
			run({ status: 'success', details: { logMissing: true, truncated: true } })
		);
		expect(state.logMissing).toBe(true);
	});

	test('a truncated run surfaces truncated independently of logMissing', () => {
		const state = buildDeployLogPanelState(run({ status: 'failed', details: { truncated: true } }));
		expect(state.logMissing).toBe(false);
		expect(state.truncated).toBe(true);
	});

	test('a running run is never deletable, even though its log is not missing', () => {
		const state = buildDeployLogPanelState(run({ status: 'running', details: undefined }));
		expect(state.deletable).toBe(false);
		expect(state.logMissing).toBe(false);
	});

	test('mutating the run to running after it was deletable flips deletable back off', () => {
		// Regression guard for a hand-rolled `run.status !== "running"` check drifting
		// out of sync with this function if someone inlines the condition again later.
		const base = run({ status: 'success' });
		expect(buildDeployLogPanelState(base).deletable).toBe(true);
		expect(buildDeployLogPanelState({ ...base, status: 'running' }).deletable).toBe(false);
	});

	test('a run with no details at all reads as available, not truncated, deletable', () => {
		const state = buildDeployLogPanelState(run({ status: 'success', details: null }));
		expect(state).toEqual({ logMissing: false, truncated: false, deletable: true });
	});
});
