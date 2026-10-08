// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { helperWaitCapMs, helperWaitDeadline, helperExitFromState, helperFailureDetail, needsDaemonErrorLookup } from '../src/lib/server/helper-wait-core';

describe('helperWaitCapMs', () => {
	test('a positive timeout is the cap', () => {
		expect(helperWaitCapMs(600_000)).toBe(600_000);
		expect(helperWaitCapMs(1)).toBe(1);
	});
	test('0 means unbounded (cap 0) - the #1382 case', () => {
		// The backup helper passes 0 on purpose. The old `timeout || 3_600_000` turned this
		// into 60 minutes and killed healthy backups; the cap here must stay 0.
		expect(helperWaitCapMs(0)).toBe(0);
	});
	test('undefined means unbounded (cap 0)', () => {
		expect(helperWaitCapMs(undefined)).toBe(0);
	});
	test('a negative timeout is treated as unbounded, not a past cap', () => {
		expect(helperWaitCapMs(-5)).toBe(0);
	});
});

describe('helperWaitDeadline', () => {
	const NOW = 1_000_000;
	test('a positive timeout yields now + timeout', () => {
		expect(helperWaitDeadline(600_000, NOW)).toBe(NOW + 600_000);
	});
	test('0 yields Infinity (unbounded) - never a 1h wall clock', () => {
		expect(helperWaitDeadline(0, NOW)).toBe(Infinity);
	});
	test('undefined yields Infinity (unbounded)', () => {
		expect(helperWaitDeadline(undefined, NOW)).toBe(Infinity);
	});
	test('Date.now() < Infinity always holds, so the poll loop never times out when unbounded', () => {
		expect(NOW < helperWaitDeadline(0, NOW)).toBe(true);
		expect(Number.MAX_SAFE_INTEGER < helperWaitDeadline(undefined, 0)).toBe(true);
	});
});

describe('helperExitFromState', () => {
	test('a normal exited container returns its exit code', () => {
		expect(helperExitFromState({ Status: 'exited', Running: false, ExitCode: 0 })).toBe(0);
		expect(helperExitFromState({ Status: 'exited', Running: false, ExitCode: 1 })).toBe(1);
	});

	test('a still-running container is not terminal (keep waiting)', () => {
		expect(helperExitFromState({ Status: 'running', Running: true, ExitCode: 0 })).toBeUndefined();
	});

	test('a brand-new created container about to start is NOT terminal (#1487 race guard)', () => {
		// created + ExitCode 0 + no Error = pre-start, must keep waiting, not resolve to 0.
		expect(helperExitFromState({ Status: 'created', Running: false, ExitCode: 0 })).toBeUndefined();
	});

	test('the #1487 case: created + non-zero ExitCode + mount Error IS terminal', () => {
		// Docker 29.x / containerd leaving the helper unstarted: exit 128, State.Error set.
		expect(helperExitFromState({
			Status: 'created', Running: false, ExitCode: 128,
			Error: 'failed to mount /var/lib/docker/rootfs/overlayfs/...: device or resource busy'
		})).toBe(128);
	});

	test('created with a non-zero ExitCode (no Error) is terminal', () => {
		expect(helperExitFromState({ Status: 'created', Running: false, ExitCode: 125 })).toBe(125);
	});

	test('created with ExitCode 0 but an Error present is terminal', () => {
		expect(helperExitFromState({ Status: 'created', Running: false, ExitCode: 0, Error: 'oci runtime error' })).toBe(0);
	});

	test('a dead container with a non-zero exit code is terminal', () => {
		expect(helperExitFromState({ Status: 'dead', Running: false, ExitCode: 137 })).toBe(137);
	});

	test('missing / partial state is not terminal', () => {
		expect(helperExitFromState(undefined)).toBeUndefined();
		expect(helperExitFromState(null)).toBeUndefined();
		expect(helperExitFromState({ Status: 'exited', Running: false })).toBeUndefined(); // no ExitCode
		expect(helperExitFromState({ Running: true })).toBeUndefined();
	});
});

describe('helperFailureDetail', () => {
	test('prefers what the container itself printed', () => {
		expect(helperFailureDetail({ stderr: 'restic: repo not found', daemonError: 'mount failed' }))
			.toBe('restic: repo not found');
		expect(helperFailureDetail({ stdout: 'restic summary', daemonError: 'mount failed' }))
			.toBe('restic summary');
	});

	// stdout is the fallback, not the primary: restic writes progress there while the
	// reason goes to stderr, so reporting stdout would bury the failure.
	test('reports stderr over stdout when both are present', () => {
		expect(
			helperFailureDetail({
				stderr: 'Fatal: unable to open repository',
				stdout: 'repository 1a2b3c opened'
			})
		).toBe('Fatal: unable to open repository');
	});

	// A container the daemon refused to start has no output at all, and its only
	// explanation is the daemon's own error.
	test('falls back to the daemon error when there is no output', () => {
		expect(helperFailureDetail({ daemonError: 'invalid mount config: bind source path does not exist' }))
			.toBe('invalid mount config: bind source path does not exist');
		expect(helperFailureDetail({ stderr: '', stdout: '', daemonError: 'failed to fulfil mount request' }))
			.toBe('failed to fulfil mount request');
	});

	test('says so when there is nothing at all', () => {
		expect(helperFailureDetail({})).toBe('no output');
		expect(helperFailureDetail({ stderr: '', stdout: '', daemonError: '' })).toBe('no output');
	});

	test('caps the detail', () => {
		expect(helperFailureDetail({ daemonError: 'x'.repeat(5000) }).length).toBe(1000);
	});
});

// The helper only explains itself if docker.ts actually collects the daemon's error
// and hands it over. Asserted at source level because docker.ts cannot be imported
// into bun (same approach as tests/env-file-values.test.ts).
describe('needsDaemonErrorLookup - when an extra inspect is worth doing', () => {
	// The wait-mode route resolves an exit code without inspecting, so the throw path
	// has to read State.Error itself or that case reports nothing.
	test('a failure with nothing to explain it needs the daemon asked', () => {
		expect(needsDaemonErrorLookup({})).toBe(true);
		expect(needsDaemonErrorLookup({ stderr: '', stdout: '', daemonError: '' })).toBe(true);
	});

	test('output of any kind already explains the failure', () => {
		expect(needsDaemonErrorLookup({ stderr: 'mount denied' })).toBe(false);
		expect(needsDaemonErrorLookup({ stdout: 'partial report' })).toBe(false);
		// Whitespace is output: a container that wrote a newline still ran.
		expect(needsDaemonErrorLookup({ stdout: '\n' })).toBe(false);
	});

	test('a daemon error already captured on the poll loop needs no second read', () => {
		expect(needsDaemonErrorLookup({ daemonError: 'no such file or directory' })).toBe(false);
	});
});

describe('daemon error wiring', () => {
	const source = readFileSync(
		new URL('../src/lib/server/docker.ts', import.meta.url),
		'utf-8'
	);

	// docker.ts cannot be imported here (better-sqlite3 transitively), so the assignment
	// sites and the hand-off are pinned at SOURCE level. These assertions match spelling,
	// not behaviour: a mutation that keeps the text and discards the value at runtime
	// survives them. The decisions they feed are covered behaviourally above; the runtime
	// wiring is covered by integration/helper-daemon-error.test.ts, which makes a real
	// daemon refuse a helper.
	test('collects State.Error on both paths that inspect a stalled helper', () => {
		const hits = source.match(/if \(st\?\.Error\) daemonError = st\.Error;/g) ?? [];
		expect(hits.length).toBe(2);
	});

	test('asks the daemon through the shared decision, not an inline condition', () => {
		expect(source).toContain('needsDaemonErrorLookup({ stderr: stderrText, stdout, daemonError })');
	});

	test('passes it to helperFailureDetail rather than discarding it', () => {
		expect(source).toContain('helperFailureDetail({ stderr: stderrText, stdout, daemonError })');
		expect(source).not.toMatch(/stderrText \|\| stdout \|\| 'no output'/);
	});
});
