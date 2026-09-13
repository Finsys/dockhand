// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import { helperWaitCapMs, helperWaitDeadline, helperExitFromState } from '../src/lib/server/helper-wait-core';

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
