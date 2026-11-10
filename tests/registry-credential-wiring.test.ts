/**
 * docker.ts and scanner.ts cannot load under bun (native modules), so these check the
 * source: each credential lookup there passes the image repo (without it an org-path
 * registry entry never matches), and the semver probe drops a rejected token. These pin
 * the call text, not its runtime value.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('credential lookups pass the repo', () => {
	test('image pulls (buildRegistryAuthHeader)', () => {
		const body = src('src/lib/server/docker.ts').split('export async function buildRegistryAuthHeader')[1].split('\nexport ')[0];
		expect(body).toContain('const { registry, repo } = parseImageReference(imageName);');
		expect(body).toContain('findRegistryCredentials(registry, repo)');
	});

	test('the semver candidate probe drops a token the registry rejected', () => {
		const body = src('src/lib/server/docker.ts').split('export async function getTagArtifactKind')[1].split('\nexport ')[0];
		expect(body).toContain('if (res.status === 401) forgetRegistryAuth(token, registry);');
	});

	test('checks a user starts ask for fresh tag lists', () => {
		const route = src('src/routes/api/containers/check-updates/+server.ts');
		const decl = 'const listedAfter = userCheckListedAfter(Date.now());';
		expect(route.split(decl)).toHaveLength(2);
		// Taken once, before the containers are listed, not per container.
		expect(route.indexOf(decl)).toBeLessThan(route.indexOf('const allContainers = await listContainers'));
		expect(route).toContain('result.localDigests ?? [], staleCheck, listedAfter)');
		expect(src('src/lib/server/scheduler/tasks/env-update-check.ts')).toContain("triggeredBy === 'manual' ? userCheckListedAfter(startTime) : undefined");
		const scanner = src('src/lib/server/scanner.ts').split('export async function checkScannerNewerVersions')[1];
		expect(scanner).toContain('const listedAfter = userCheckListedAfter(Date.now());');
		expect(scanner).toContain("{ maxBump: 'major', matchFlavor: true }, undefined, [], undefined, listedAfter)");
	});

	test('registry-mode scans', () => {
		expect(src('src/lib/server/scanner.ts')).toContain(
			'findRegistryCredentials(registry, parseImageReference(registryScanTarget.ref).repo)'
		);
	});
});
