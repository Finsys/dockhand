import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	composeCopyFileConfigPaths, parseComposeCopyFilePaths, discoverComposeCopyFilePaths
} from '../src/lib/server/compose-copy-files';

const labels = {
	'com.docker.compose.project': 'deployed-with-p',
	'com.docker.compose.service': 'app',
	'com.docker.compose.project.working_dir': '/project',
	'com.docker.compose.project.config_files': 'compose.yaml,override.yaml'
};
const parse = (...sources: string[]) => parseComposeCopyFilePaths(sources, labels);
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Compose copy-file discovery', () => {
	test('short syntax selects only env secrets belonging to the labeled service', () => {
		expect(parse(`
name: different-name-overridden-by-p
services:
  app:
    secrets: [token, from-file, external, inline]
  other:
    secrets: [other-token]
secrets:
  token: {environment: TOKEN}
  from-file: {file: ./token.txt}
  external: {external: true}
  inline: {content: literal}
  other-token: {environment: OTHER_TOKEN}
`)).toEqual(['/run/secrets/token']);
	});
	test('long syntax honors source aliases, absolute/relative targets, and default targets', () => {
		expect(parse(`
services:
  app:
    secrets:
      - {source: token, target: /custom/renamed}
      - {source: token, target: renamed}
      - {source: token}
      - token
secrets:
  token: {environment: TOKEN, name: external-name}
`)).toEqual(['/custom/renamed', '/run/secrets/renamed', '/run/secrets/token']);
	});
	test('merges multiple files in order, with service references keyed by target', () => {
		expect(parse(`
services:
  app:
    secrets: [{source: old, target: token}, retained]
secrets:
  old: {environment: OLD}
  retained: {environment: RETAINED}
`, `
services:
  app:
    secrets: [{source: disk, target: token}, added]
secrets:
  disk: {file: ./token}
  added: {environment: ADDED}
`)).toEqual(['/run/secrets/retained', '/run/secrets/added']);
	});
	test('missing ownership labels or unmatched service do not discover another service', () => {
		const source = 'services: {app: {secrets: [token]}}\nsecrets: {token: {environment: TOKEN}}';
		for (const own of [{}, { ...labels, 'com.docker.compose.project': '' }, { ...labels, 'com.docker.compose.service': 'other' }]) {
			expect(parseComposeCopyFilePaths([source], own)).toEqual([]);
		}
	});
	test('unresolved names/targets, invalid YAML, includes and extends fall back without guessing', () => {
		for (const source of [
			'!!invalid', 'services: [',
			'include: other.yaml\nservices: {app: {secrets: [token]}}',
			'services: {app: {extends: {service: base}, secrets: [token]}}',
			'services: {app: {secrets: ["${SECRET}"]}}',
			'services: {app: {secrets: [{source: token, target: "${TARGET}"}]}}',
			'services: {app: {secrets: [{source: token, target: /run/../token}]}}',
			'services: {app: {secrets: !reset []}}'
		]) expect(parse(source + '\nsecrets: {token: {environment: TOKEN}}')).toEqual([]);
	});
	test('does not interpolate or read environment values', () => {
		expect(parse('services: {app: {secrets: [token]}}\nsecrets: {token: {environment: "${UNSET_VARIABLE}"}}'))
			.toEqual(['/run/secrets/token']);
	});
	test('resolves comma-separated config paths against the container working directory', () => {
		expect(composeCopyFileConfigPaths(labels)).toEqual(['/project/compose.yaml', '/project/override.yaml']);
		expect(composeCopyFileConfigPaths({ ...labels, 'com.docker.compose.project.config_files': '/elsewhere/base.yaml,../override.yaml' }))
			.toEqual(['/elsewhere/base.yaml', '/override.yaml']);
		for (const files of ['', '-', 'compose.yaml,']) {
			expect(composeCopyFileConfigPaths({ ...labels, 'com.docker.compose.project.config_files': files })).toEqual([]);
		}
	});
	test('accepts Windows comma lists and semicolon compatibility lists without splitting drives', () => {
		for (const separator of [',', ';']) {
			expect(composeCopyFileConfigPaths({
				...labels, 'com.docker.compose.project.working_dir': 'C:\\project',
				'com.docker.compose.project.config_files': ['compose.yaml', 'D:\\override.yaml'].join(separator)
			})).toEqual(['C:\\project\\compose.yaml', 'D:\\override.yaml']);
		}
	});
	test('reads local files; an unreadable override discards partial discovery', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'compose-discovery-test-'));
		directories.push(dir);
		await writeFile(join(dir, 'compose.yaml'), 'services: {app: {secrets: [token]}}\nsecrets: {token: {environment: TOKEN}}');
		const own = { ...labels, 'com.docker.compose.project.working_dir': dir, 'com.docker.compose.project.config_files': 'compose.yaml' };
		expect(await discoverComposeCopyFilePaths(own)).toEqual(['/run/secrets/token']);
		expect(await discoverComposeCopyFilePaths({ ...own, 'com.docker.compose.project.config_files': 'compose.yaml,missing.yaml' })).toEqual([]);
		expect(await discoverComposeCopyFilePaths({ ...own, 'com.docker.compose.project.config_files': dir })).toEqual([]);
		await writeFile(join(dir, 'compose.yaml'), 'invalid: [');
		expect(await discoverComposeCopyFilePaths(own)).toEqual([]);
		await writeFile(join(dir, 'compose.yaml'), ' '.repeat(4 * 1024 * 1024 + 1));
		expect(await discoverComposeCopyFilePaths(own)).toEqual([]);
	});
});
