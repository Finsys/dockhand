import { describe, expect, test } from 'bun:test';
import { isSafeNetworkName, planNetworkEnvVars } from '../src/lib/server/self-update-network-core';

/**
 * What the update sidecar is allowed to be told about a container's networks.
 *
 * The sidecar reads these names from its environment and passes them to the docker
 * CLI. Creating a network is a permission of its own, so on an instance with roles
 * the person who chose a name need not be the administrator who later runs the
 * update - which makes the name untrusted input to a privileged step. Docker stores
 * almost anything: `docker network create 'a;id;b'` succeeds.
 */

describe('a name that is plainly a network name', () => {
	test('the ordinary shapes travel', () => {
		for (const name of ['bridge', 'my_net', 'my-net', 'my.net', 'proj_default', 'net123']) {
			expect(isSafeNetworkName(name)).toBe(true);
		}
	});
});

describe('a name that is something else', () => {
	test('shell metacharacters are refused', () => {
		for (const name of ['a;id;b', 'a$(id)b', 'a`id`b', 'a|id', 'a&b', 'a>b', "a'b", 'a"b']) {
			expect(isSafeNetworkName(name)).toBe(false);
		}
	});

	test('a name that would read as a flag is refused', () => {
		// It reaches the CLI as an argument, where a leading dash is an option.
		expect(isSafeNetworkName('--rm')).toBe(false);
		expect(isSafeNetworkName('-v/:/host')).toBe(false);
	});

	test('whitespace is refused, because the sidecar splits on it', () => {
		// NETWORKS is a space-separated list, so a name with a space is two names.
		for (const name of ['a b', 'a\tb', 'a\nb']) {
			expect(isSafeNetworkName(name)).toBe(false);
		}
	});

	test('an absurd length is refused', () => {
		expect(isSafeNetworkName('a'.repeat(257))).toBe(false);
	});

	test('nothing that is not a string', () => {
		for (const v of [null, undefined, 42, {}, []]) expect(isSafeNetworkName(v)).toBe(false);
	});
});

describe('planning what the sidecar reconnects', () => {
	test('an ordinary container keeps its networks and options', () => {
		const plan = planNetworkEnvVars({
			'my.net': { IPAMConfig: { IPv4Address: '10.0.0.5' }, Aliases: ['web'] }
		});
		expect(plan.envVars).toEqual(['NETWORKS=my.net', 'NETWORK_OPTS_my_net=--ip 10.0.0.5 --alias web']);
		expect(plan.skipped).toEqual([]);
	});

	test('a hostile name is dropped and reported, not escaped', () => {
		// Coming back on one fewer network is a smaller failure than a name reaching
		// a shell, and the caller has to be able to say which was left off.
		const plan = planNetworkEnvVars({ bridge: {}, 'a;id;b': {} });
		expect(plan.envVars).toEqual(['NETWORKS=bridge']);
		expect(plan.skipped).toEqual(['a;id;b']);
	});

	test('a container on nothing but a hostile network reconnects to nothing', () => {
		const plan = planNetworkEnvVars({ 'a;touch /tmp/pwn;b': {} });
		expect(plan.envVars).toEqual([]);
		expect(plan.skipped).toHaveLength(1);
	});

	test('an option value that is not plainly an address or alias is left off', () => {
		// Each lands in an unquoted expansion in the sidecar, so a space in one would
		// become a second argument to docker.
		const plan = planNetworkEnvVars({
			netA: { IPAMConfig: { IPv4Address: '10.0.0.5 --privileged' }, Aliases: ['ok', 'not ok'] }
		});
		expect(plan.envVars).toEqual(['NETWORKS=netA', 'NETWORK_OPTS_netA=--alias ok']);
	});

	test('no networks at all', () => {
		expect(planNetworkEnvVars({})).toEqual({ envVars: [], skipped: [] });
		expect(planNetworkEnvVars(null)).toEqual({ envVars: [], skipped: [] });
		expect(planNetworkEnvVars(undefined)).toEqual({ envVars: [], skipped: [] });
	});

	test('a network with no options contributes only its name', () => {
		expect(planNetworkEnvVars({ bridge: {} }).envVars).toEqual(['NETWORKS=bridge']);
	});
});

describe('the env var names the sidecar looks up', () => {
	test('dots and dashes become underscores, as the sidecar expects', () => {
		// The sidecar builds the variable name the same way; if the two disagree the
		// options are silently lost and the container comes back without them.
		const plan = planNetworkEnvVars({ 'a-b.c': { Aliases: ['z'] } });
		expect(plan.envVars).toEqual(['NETWORKS=a-b.c', 'NETWORK_OPTS_a_b_c=--alias z']);
	});

	test('several networks share one NETWORKS line', () => {
		const plan = planNetworkEnvVars({ bridge: {}, backend: { Aliases: ['api'] } });
		expect(plan.envVars[0]).toBe('NETWORKS=bridge backend');
		expect(plan.envVars).toContain('NETWORK_OPTS_backend=--alias api');
	});

	test('a name with whitespace never reaches the space-separated list', () => {
		// NETWORKS is split on whitespace, so a name containing any would become two.
		const plan = planNetworkEnvVars({ 'a b': {}, ok: {} });
		expect(plan.envVars).toEqual(['NETWORKS=ok']);
		expect(plan.skipped).toEqual(['a b']);
	});
});

describe('names the daemon itself accepts', () => {
	test('a leading underscore or dot is kept', () => {
		// Verified against a real daemon: `docker network create _leading` succeeds,
		// so dropping it would disconnect a network that genuinely exists.
		const plan = planNetworkEnvVars({ _leading: {}, '.leading': {} });
		expect(plan.skipped).toEqual([]);
		expect(plan.envVars[0]).toBe('NETWORKS=_leading .leading');
	});

	test('a leading dash is still refused', () => {
		// The daemon refuses it too, and it would reach the CLI as a flag.
		const plan = planNetworkEnvVars({ '-leading': {}, ok: {} });
		expect(plan.envVars).toEqual(['NETWORKS=ok']);
		expect(plan.skipped).toEqual(['-leading']);
	});
});

describe('addresses a real deployment uses', () => {
	test('an IPv6 address starting with a colon is kept', () => {
		// The compressed form is legal and a user may pin one in IPAMConfig; dropping
		// it would bring the container back without its address.
		const plan = planNetworkEnvVars({ v6: { IPAMConfig: { IPv6Address: '::1' } } });
		expect(plan.envVars).toContain('NETWORK_OPTS_v6=--ip6 ::1');
	});

	test('a value that would read as a flag is still dropped', () => {
		// The expansion is unquoted, so a leading dash reaches docker as an option.
		const plan = planNetworkEnvVars({ n: { Aliases: ['--privileged'], IPAMConfig: { IPv4Address: '-rm' } } });
		expect(plan.envVars).toEqual(['NETWORKS=n']);
	});

	test('the compose default and other ordinary names survive', () => {
		// Dropping one of these would silently disconnect a real deployment.
		const names = ['bridge', 'myproject_default', 'my-app_net', 'web.prod', 'App_Net', '2fa-net'];
		const plan = planNetworkEnvVars(Object.fromEntries(names.map((n) => [n, {}])));
		expect(plan.skipped).toEqual([]);
		expect(plan.envVars[0]).toBe(`NETWORKS=${names.join(' ')}`);
	});
});
