import { describe, expect, test } from 'bun:test';
import { hasBuildSection } from '../src/lib/utils/compose-build-detect';

describe('hasBuildSection', () => {
	test('no services at all -- false', () => {
		expect(hasBuildSection('networks:\n  default: {}\n')).toBe(false);
	});

	test('every service uses only image: -- false', () => {
		const compose = 'services:\n  app:\n    image: demo:1\n  db:\n    image: postgres:16\n';
		expect(hasBuildSection(compose)).toBe(false);
	});

	// build: can be a bare string (`build: ./dir`)...
	test('build: as a bare string on one service -- true', () => {
		const compose = 'services:\n  app:\n    build: ./app\n  db:\n    image: postgres:16\n';
		expect(hasBuildSection(compose)).toBe(true);
	});

	// ...or an object (`build: {context: ., dockerfile: ...}`) -- both forms must be
	// detected the same way (truthy check, not typeof), matching
	// ComposeGraphViewer.svelte's `config.image || (config.build ? 'build' : 'custom')`.
	test('build: as an object with context/dockerfile on one service -- true', () => {
		const compose = 'services:\n  app:\n    build:\n      context: .\n      dockerfile: Dockerfile\n  db:\n    image: postgres:16\n';
		expect(hasBuildSection(compose)).toBe(true);
	});

	test('only the SECOND service has build: -- still true (checks every service, not just the first)', () => {
		const compose = 'services:\n  db:\n    image: postgres:16\n  app:\n    build: ./app\n';
		expect(hasBuildSection(compose)).toBe(true);
	});

	test('invalid YAML mid-edit -- false, does not throw', () => {
		expect(hasBuildSection('services:\n  app:\n    build: [unterminated')).toBe(false);
	});

	test('empty content -- false', () => {
		expect(hasBuildSection('')).toBe(false);
	});
});
