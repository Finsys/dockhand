/**
 * Unit tests for system container detection and filtering.
 *
 * Verifies that Dockhand and Hawser containers are correctly identified
 * and excluded from batch update operations (#485).
 *
 * Run with: bun test tests/system-container-filter.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	batchUpdateStillApplies,
	isEnvironmentTransportContainer,
	isDockhandContainer,
	isHawserContainer,
	isSystemContainer,
	isPodmanInfraContainer
} from '../src/lib/server/scheduler/tasks/update-utils';

describe('isDockhandContainer', () => {
	test('matches fnsys/dockhand', () => {
		expect(isDockhandContainer('fnsys/dockhand:latest')).toBe(true);
		expect(isDockhandContainer('fnsys/dockhand:v1.0.0')).toBe(true);
		expect(isDockhandContainer('fnsys/dockhand')).toBe(true);
	});

	test('matches registry-prefixed dockhand', () => {
		expect(isDockhandContainer('registry.example.com/dockhand:abc123')).toBe(true);
		expect(isDockhandContainer('ghcr.io/finsys/dockhand:latest')).toBe(true);
	});

	test('matches plain dockhand', () => {
		expect(isDockhandContainer('dockhand:latest')).toBe(true);
		expect(isDockhandContainer('dockhand')).toBe(true);
	});

	test('is case insensitive', () => {
		expect(isDockhandContainer('Fnsys/Dockhand:Latest')).toBe(true);
		expect(isDockhandContainer('FNSYS/DOCKHAND')).toBe(true);
	});

	test('does not match unrelated images', () => {
		expect(isDockhandContainer('nginx:latest')).toBe(false);
		expect(isDockhandContainer('my-dockhand-fork:v1')).toBe(false);
	});
});

describe('isHawserContainer', () => {
	test('matches finsys/hawser', () => {
		expect(isHawserContainer('finsys/hawser:latest')).toBe(true);
		expect(isHawserContainer('finsys/hawser:v0.5.0')).toBe(true);
		expect(isHawserContainer('finsys/hawser')).toBe(true);
	});

	test('matches ghcr.io/finsys/hawser', () => {
		expect(isHawserContainer('ghcr.io/finsys/hawser:latest')).toBe(true);
		expect(isHawserContainer('ghcr.io/finsys/hawser')).toBe(true);
	});

	test('is case insensitive', () => {
		expect(isHawserContainer('Finsys/Hawser:Latest')).toBe(true);
		expect(isHawserContainer('GHCR.IO/FINSYS/HAWSER')).toBe(true);
	});

	test('does not match unrelated images', () => {
		expect(isHawserContainer('nginx:latest')).toBe(false);
		expect(isHawserContainer('hawser-custom:v1')).toBe(false);
	});
});

describe('isSystemContainer', () => {
	test('returns "dockhand" for Dockhand images', () => {
		expect(isSystemContainer('fnsys/dockhand:latest')).toBe('dockhand');
	});

	test('returns "hawser" for Hawser images', () => {
		expect(isSystemContainer('finsys/hawser:latest')).toBe('hawser');
		expect(isSystemContainer('ghcr.io/finsys/hawser:v1')).toBe('hawser');
	});

	test('returns null for regular images', () => {
		expect(isSystemContainer('nginx:latest')).toBeNull();
		expect(isSystemContainer('redis:7')).toBeNull();
		expect(isSystemContainer('postgres:16')).toBeNull();
	});
});

describe('batch update filtering (#485)', () => {
	// Simulates the check-updates response filtering
	interface CheckResult {
		containerId: string;
		containerName: string;
		imageName: string;
		hasUpdate: boolean;
		systemContainer: string | null;
	}

	const mockResults: CheckResult[] = [
		{ containerId: 'c1', containerName: 'nginx', imageName: 'nginx:latest', hasUpdate: true, systemContainer: null },
		{ containerId: 'c2', containerName: 'redis', imageName: 'redis:7', hasUpdate: true, systemContainer: null },
		{ containerId: 'c3', containerName: 'dockhand', imageName: 'fnsys/dockhand:latest', hasUpdate: true, systemContainer: 'dockhand' },
		{ containerId: 'c4', containerName: 'hawser-agent', imageName: 'ghcr.io/finsys/hawser:v0.5', hasUpdate: true, systemContainer: 'hawser' },
		{ containerId: 'c5', containerName: 'postgres', imageName: 'postgres:16', hasUpdate: false, systemContainer: null },
	];

	test('updatesFound count excludes system containers', () => {
		const updatesFound = mockResults.filter(r => r.hasUpdate && !r.systemContainer).length;
		expect(updatesFound).toBe(2); // nginx + redis only
	});

	test('containersWithUpdates excludes system containers', () => {
		const containersWithUpdates = mockResults.filter(r => r.hasUpdate && !r.systemContainer);
		expect(containersWithUpdates.map(r => r.containerName)).toEqual(['nginx', 'redis']);
	});

	test('system containers with updates are not included', () => {
		const containersWithUpdates = mockResults.filter(r => r.hasUpdate && !r.systemContainer);
		const ids = containersWithUpdates.map(r => r.containerId);
		expect(ids).not.toContain('c3'); // dockhand
		expect(ids).not.toContain('c4'); // hawser
	});
});

describe('isPodmanInfraContainer (#1221)', () => {
	test('accepts pod-id-prefixed infra (real podman 5.4.2 shape)', () => {
		expect(isPodmanInfraContainer('fb575a549efc-infra')).toBe(true);
	});

	test('accepts pod-name-prefixed infra (the #1221 reporter shape)', () => {
		expect(isPodmanInfraContainer('someapp-pod-infra')).toBe(true);
		expect(isPodmanInfraContainer('testpod-infra')).toBe(true);
	});

	test('accepts underscore separator', () => {
		expect(isPodmanInfraContainer('foo_infra')).toBe(true);
	});

	test('is case-insensitive', () => {
		expect(isPodmanInfraContainer('TESTPOD-INFRA')).toBe(true);
	});

	test('rejects user containers that merely contain "infra"', () => {
		expect(isPodmanInfraContainer('my-infrastructure')).toBe(false);
		expect(isPodmanInfraContainer('core-infra-svc')).toBe(false);
		expect(isPodmanInfraContainer('infra-monitoring')).toBe(false);
		expect(isPodmanInfraContainer('infra')).toBe(false); // no separator
	});

	test('rejects empty / undefined', () => {
		expect(isPodmanInfraContainer(undefined)).toBe(false);
		expect(isPodmanInfraContainer('')).toBe(false);
	});

	test('handles leading-slash names (Docker API returns /name)', () => {
		expect(isPodmanInfraContainer('/fb575a549efc-infra')).toBe(true);
	});
});

/**
 * A socket proxy serving an environment is as load-bearing as the Hawser agent:
 * stopping it cuts the connection the update itself is running over, and every
 * later call fails until somebody restarts it by hand (#1689).
 */
describe('isEnvironmentTransportContainer', () => {
	// Measured on a real lscr.io/linuxserver/socket-proxy serving dh-test-proxy: it
	// mounts the daemon socket and publishes the environment's port (#1689).
	const SOCK = ['/var/run/docker.sock'];
	const proxy = { name: 'socket-proxy', mountSources: SOCK, publishedPorts: [{ port: 2375, hostIp: '0.0.0.0' }] };

	test('a socket proxy publishing the environment port is the transport', () => {
		expect(isEnvironmentTransportContainer(proxy, '192.168.1.221', 2375)).toBe(true);
	});

	test('a container that only mounts the socket is not', () => {
		expect(isEnvironmentTransportContainer(
			{ name: 'cadvisor', mountSources: SOCK, publishedPorts: [{ port: 8080 }] },
			'192.168.1.221', 2375
		)).toBe(false);
	});

	test('a container that only publishes the port is not', () => {
		expect(isEnvironmentTransportContainer(
			{ name: 'web', mountSources: [], publishedPorts: [{ port: 2375 }] },
			'192.168.1.221', 2375
		)).toBe(false);
	});

	// A socket or edge environment stores 2375 in the same column without reaching
	// anything through it. The caller must pass no port there; if it did, an
	// unrelated container publishing 2375 would stop being updated.
	test('with no port in play the functional signal cannot fire', () => {
		const portainer = { name: 'portainer', mountSources: SOCK, publishedPorts: [{ port: 2375 }, { port: 9443 }] };
		expect(isEnvironmentTransportContainer(portainer, null, null)).toBe(false);
		expect(isEnvironmentTransportContainer(portainer, null, undefined)).toBe(false);
	});

	test('a proxy serving a DIFFERENT environment port is not this one transport', () => {
		expect(isEnvironmentTransportContainer(proxy, '192.168.1.221', 2376)).toBe(false);
	});

	// Two proxies on one machine both publish 2375, each bound to its own address.
	test('a sibling proxy bound to another address is not this one transport', () => {
		const other = { name: 'socket-proxy-b', mountSources: SOCK, publishedPorts: [{ port: 2375, hostIp: '192.168.1.50' }] };
		expect(isEnvironmentTransportContainer(other, '192.168.1.221', 2375)).toBe(false);
		expect(isEnvironmentTransportContainer(other, '192.168.1.50', 2375)).toBe(true);
	});

	// The HOST side is authoritative: `-p 12375:2375` is reached on 12375.
	test('an asymmetric publish is matched on the host port', () => {
		const asym = { name: 'p', mountSources: SOCK, publishedPorts: [{ port: 12375, hostIp: '0.0.0.0' }] };
		expect(isEnvironmentTransportContainer(asym, '10.0.0.5', 12375)).toBe(true);
		expect(isEnvironmentTransportContainer(asym, '10.0.0.5', 2375)).toBe(false);
	});

	test('a bare port number is still accepted', () => {
		expect(isEnvironmentTransportContainer(
			{ name: 'p', mountSources: SOCK, publishedPorts: [2375] }, '192.168.1.221', 2375
		)).toBe(true);
	});

	test('a rootless socket path still counts', () => {
		expect(isEnvironmentTransportContainer(
			{ name: 'p', mountSources: ['/run/user/1000/docker.sock'], publishedPorts: [{ port: 2375 }] },
			'192.168.1.221', 2375
		)).toBe(true);
	});

	// The name branch exists for a proxy whose port is published inside a user
	// network. It still requires the socket: otherwise any container named after
	// the environment host would exempt itself from updates, and the host is
	// readable by anyone with environments:view.
	test('the container the environment is addressed by is the transport', () => {
		expect(isEnvironmentTransportContainer({ name: 'socket-proxy', mountSources: SOCK }, 'socket-proxy')).toBe(true);
	});

	test('a name squat without the socket is not the transport', () => {
		expect(isEnvironmentTransportContainer({ name: 'socket-proxy', mountSources: [] }, 'socket-proxy')).toBe(false);
		expect(isEnvironmentTransportContainer('socket-proxy', 'socket-proxy')).toBe(false);
	});

	test('a sibling container on the same environment is not', () => {
		expect(isEnvironmentTransportContainer({ name: 'nginx', mountSources: SOCK }, 'socket-proxy')).toBe(false);
	});

	test('matching ignores case, because DNS does', () => {
		expect(isEnvironmentTransportContainer({ name: 'Socket-Proxy', mountSources: SOCK }, 'socket-proxy')).toBe(true);
		expect(isEnvironmentTransportContainer({ name: 'socket-proxy', mountSources: SOCK }, 'SOCKET-PROXY')).toBe(true);
	});

	test('a qualified host still names its first label', () => {
		expect(isEnvironmentTransportContainer({ name: 'socket-proxy', mountSources: SOCK }, 'socket-proxy.lan')).toBe(true);
	});

	test('a container named like an octet does not match an IP host', () => {
		expect(isEnvironmentTransportContainer({ name: '192', mountSources: SOCK }, '192.168.1.221')).toBe(false);
		expect(isEnvironmentTransportContainer({ name: '127', mountSources: SOCK }, '127.0.0.1')).toBe(false);
	});

	test('a host carrying a port is not treated as a name', () => {
		expect(isEnvironmentTransportContainer({ name: 'socket-proxy', mountSources: SOCK }, 'socket-proxy:2375')).toBe(false);
	});

	test('a local socket environment has no host and matches nothing', () => {
		for (const host of [null, undefined, '', '   ']) {
			expect(isEnvironmentTransportContainer({ name: 'socket-proxy', mountSources: SOCK }, host)).toBe(false);
		}
	});

	test('a missing container name matches nothing', () => {
		for (const name of [undefined, '']) {
			expect(isEnvironmentTransportContainer({ name, mountSources: SOCK }, 'socket-proxy')).toBe(false);
		}
	});

	test('a partial name is not the transport', () => {
		expect(isEnvironmentTransportContainer({ name: 'socket', mountSources: SOCK }, 'socket-proxy')).toBe(false);
		expect(isEnvironmentTransportContainer({ name: 'socket-proxy-old', mountSources: SOCK }, 'socket-proxy')).toBe(false);
	});

	// A compose project renames the container, so the name no longer matches the
	// service DNS name; the functional signal is what still identifies it.
	test('a compose-renamed proxy is still caught by what it does', () => {
		expect(isEnvironmentTransportContainer(
			{ name: 'infra-socket-proxy-1', mountSources: SOCK, publishedPorts: [{ port: 2375, hostIp: '0.0.0.0' }] },
			'socket-proxy', 2375
		)).toBe(true);
	});
});

/**
 * The browser's selection can be stale: updating a container outside Dockhand
 * leaves its pending row behind, and the batch would then recreate a container
 * that is already current (#1689).
 */
describe('batchUpdateStillApplies', () => {
	test('the container still runs what the check recorded', () => {
		expect(batchUpdateStillApplies('nginx:1.25', 'nginx:1.25')).toBe(true);
	});

	test('a container updated elsewhere no longer applies', () => {
		expect(batchUpdateStillApplies('nginx:1.25', 'nginx:1.27')).toBe(false);
		expect(batchUpdateStillApplies(
			'lscr.io/linuxserver/socket-proxy:latest',
			'lscr.io/linuxserver/socket-proxy:1.2.3'
		)).toBe(false);
	});

	test('surrounding whitespace is not a difference', () => {
		expect(batchUpdateStillApplies(' nginx:1.25 ', 'nginx:1.25')).toBe(true);
	});

	// Hand-picking a container that was never in a check is legitimate, so the
	// absence of a recorded image must not block it.
	test('no recorded image means proceed', () => {
		for (const rec of [null, undefined, '']) {
			expect(batchUpdateStillApplies(rec, 'nginx:1.25')).toBe(true);
		}
	});

	test('an unreadable current image means proceed', () => {
		for (const cur of [null, undefined, '']) {
			expect(batchUpdateStillApplies('nginx:1.25', cur)).toBe(true);
		}
	});

	test('a tag difference is a difference', () => {
		expect(batchUpdateStillApplies('nginx:latest', 'nginx:1.27')).toBe(false);
	});
});

/**
 * The handler reads the HOST side of each port binding. A unit test cannot see
 * which side it read - the helper is handed a finished list - so the choice is
 * pinned here on the source. This asserts the spelling, not the behaviour: what
 * would pin the behaviour is an integration test against a daemon publishing
 * `-p 12375:2375`.
 */
describe('batch update reads the host side of a port binding', () => {
	const src = readFileSync(
		new URL('../src/routes/api/containers/batch-update-stream/+server.ts', import.meta.url),
		'utf8'
	);

	test('publishedPorts comes from HostPort, not the container port key', () => {
		expect(src).toContain('x?.HostPort');
		// Object.keys over Ports would read "2375/tcp", the CONTAINER port.
		expect(src).not.toContain('Object.keys(inspectData.NetworkSettings');
	});

	test('the binding address is carried through, so a sibling proxy can be told apart', () => {
		expect(src).toContain('hostIp: x?.HostIp');
	});

	test('the port is only consulted for a connection actually made over one', () => {
		expect(src).toContain("env?.connectionType === 'direct'");
		expect(src).toContain("env?.connectionType === 'hawser-standard'");
	});
});
