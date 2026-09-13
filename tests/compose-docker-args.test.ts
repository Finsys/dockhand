/**
 * #1393: the compose daemon must be passed on the `docker -H` flag, never as
 * DOCKER_HOST in the shell env (which leaks into services that pass through or
 * interpolate DOCKER_HOST). These are the pure resolver + argv builder.
 */
import { describe, test, expect } from 'bun:test';
import {
	resolveComposeDockerHost,
	buildComposeBaseArgs
} from '../src/lib/server/compose-docker-args';

describe('resolveComposeDockerHost', () => {
	test('per-env dockerHost wins', () => {
		expect(resolveComposeDockerHost('tcp://remote:2375', 'unix:///own.sock')).toBe('tcp://remote:2375');
	});
	test("falls back to Dockhand's own DOCKER_HOST (socket-proxy setup)", () => {
		expect(resolveComposeDockerHost(undefined, 'tcp://dockhand-socket-proxy:2375')).toBe(
			'tcp://dockhand-socket-proxy:2375'
		);
	});
	test('undefined for a plain local socket (no host anywhere)', () => {
		expect(resolveComposeDockerHost(undefined, undefined)).toBeUndefined();
		expect(resolveComposeDockerHost(null, null)).toBeUndefined();
		expect(resolveComposeDockerHost('', '')).toBeUndefined();
	});
});

describe('buildComposeBaseArgs', () => {
	test('puts the daemon on -H BEFORE compose (global docker flag)', () => {
		expect(buildComposeBaseArgs('mystack', 'tcp://remote:2375')).toEqual([
			'docker',
			'-H',
			'tcp://remote:2375',
			'compose',
			'-p',
			'mystack'
		]);
	});
	test('omits -H entirely when there is no host (default local socket)', () => {
		const args = buildComposeBaseArgs('mystack', undefined);
		expect(args).toEqual(['docker', 'compose', '-p', 'mystack']);
		// crucially, DOCKER_HOST / -H never appears
		expect(args).not.toContain('-H');
	});
	test('the daemon is NEVER placed after `compose` (would be an invalid subcommand flag)', () => {
		const args = buildComposeBaseArgs('s', 'unix:///own.sock');
		expect(args.indexOf('-H')).toBeLessThan(args.indexOf('compose'));
	});
});
