// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import { deriveContextFromLists } from '../../src/lib/server/compose-validate/context-core';

describe('deriveContextFromLists', () => {
	const containers = [
		{ name: 'other-web-1', ports: [{ PublicPort: 8080 }, { PublicPort: 443 }] },
		{ name: 'mystack-db-1', ports: [{ PublicPort: 5432 }] } // self
	];

	test('collects used host ports and container names', () => {
		const ctx = deriveContextFromLists(containers, ['proxy'], ['data']);
		expect([...ctx.usedHostPorts!].sort()).toEqual([443, 5432, 8080]);
		expect(ctx.existingContainerNames!.has('other-web-1')).toBe(true);
		expect(ctx.existingNetworks!.has('proxy')).toBe(true);
		expect(ctx.existingVolumes!.has('data')).toBe(true);
	});

	test('excludes THIS stack own containers (self)', () => {
		const ctx = deriveContextFromLists(containers, [], [], 'mystack');
		expect(ctx.usedHostPorts!.has(5432)).toBe(false); // self db port not counted
		expect(ctx.usedHostPorts!.has(8080)).toBe(true); // other stack still counted
		expect(ctx.existingContainerNames!.has('mystack-db-1')).toBe(false);
	});

	test('excludes self by compose project LABEL even with a custom container_name', () => {
		// A service with `container_name: wzml` runs as a container literally named "wzml"
		// (no `<stack>-` prefix), so name-prefix matching misses it. The compose project
		// label is authoritative and must still exclude it - otherwise editing the running
		// stack falsely reports a container_name collision against itself.
		const withCustomNames = [
			{ name: 'wzml', ports: [{ PublicPort: 8080 }], labels: { 'com.docker.compose.project': 'wzml' } },
			{ name: 'wzml_tunnel', labels: { 'com.docker.compose.project': 'wzml' } },
			{ name: 'unrelated', ports: [{ PublicPort: 9090 }], labels: { 'com.docker.compose.project': 'other' } }
		];
		const ctx = deriveContextFromLists(withCustomNames, [], [], 'wzml');
		expect(ctx.existingContainerNames!.has('wzml')).toBe(false); // self, excluded
		expect(ctx.existingContainerNames!.has('wzml_tunnel')).toBe(false); // self, excluded
		expect(ctx.existingContainerNames!.has('unrelated')).toBe(true); // other stack kept
		// Ports follow the same exclusion: the self stack's published port is NOT counted
		// (so re-editing it isn't flagged as a cross-stack port collision), but another
		// stack's port still is.
		expect(ctx.usedHostPorts!.has(8080)).toBe(false); // self port, excluded
		expect(ctx.usedHostPorts!.has(9090)).toBe(true); // other stack port kept
	});

	test('create mode (no selfStackName) excludes nothing - a name clash must be flagged', () => {
		// A NEW stack named "wzml" has no own containers yet; a running "wzml" must still
		// be reported as a collision, so with selfStackName null/undefined nothing is excluded.
		const running = [
			{ name: 'wzml', ports: [{ PublicPort: 8080 }], labels: { 'com.docker.compose.project': 'wzml' } }
		];
		const ctx = deriveContextFromLists(running, [], [], null);
		expect(ctx.existingContainerNames!.has('wzml')).toBe(true); // clash surfaced
		expect(ctx.usedHostPorts!.has(8080)).toBe(true);
	});

	test('ignores containers with no published ports', () => {
		const ctx = deriveContextFromLists([{ name: 'x-1', ports: [] }], [], []);
		expect(ctx.usedHostPorts!.size).toBe(0);
	});

	test('maps each used port to the container that publishes it', () => {
		const ctx = deriveContextFromLists(containers, [], []);
		expect(ctx.hostPortOwners!.get(8080)).toBe('other-web-1');
		expect(ctx.hostPortOwners!.get(443)).toBe('other-web-1');
	});
});
