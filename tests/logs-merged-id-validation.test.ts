// /api/logs/merged interpolates every requested container id into a Docker API path, so each
// one goes through validateDockerIdParam before any connection is made. The route cannot be
// imported here (it pulls in the database), so the wiring is read from the source.
// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateDockerIdParam } from '../src/lib/server/docker-validation';

const src = readFileSync(join(import.meta.dir, '..', 'src', 'routes', 'api', 'logs', 'merged', '+server.ts'), 'utf8');
const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const get = code.slice(code.indexOf('export const GET'));

test('every requested id is validated before the Docker config is resolved', () => {
	expect(get).toMatch(/for \(const id of containerIds\) \{\s*const invalid = validateDockerIdParam\(id, 'container'\);\s*if \(invalid\) return invalid;\s*\}/);
	const check = get.indexOf('validateDockerIdParam(id');
	expect(check).toBeGreaterThan(get.indexOf('const containerIds ='));
	for (const sink of ['getDockerConfig(', 'handleEdgeMergedLogs(', 'setupContainer(']) {
		expect(get.indexOf(sink)).toBeGreaterThan(check);
	}
});

test('the validator refuses ids that would leave the container path', () => {
	for (const bad of ['../../build', '..', 'a/b', 'a\\b', 'a%2f..', 'x\0y', '']) {
		expect(validateDockerIdParam(bad, 'container')?.status).toBe(400);
	}
	for (const ok of ['3f2a9c1b7d4e', 'my-app_web-1', 'nginx.1']) {
		expect(validateDockerIdParam(ok, 'container')).toBeNull();
	}
});
