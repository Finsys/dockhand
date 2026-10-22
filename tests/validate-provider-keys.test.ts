import { describe, test, expect } from 'bun:test';
import {
	withProviderKeysAsSet,
	sanitizeProviderKeys, isPlaceholderArtefact} from '../src/lib/utils/validate-provider-keys';

describe('#1621 - provider-supplied keys count as set when validating', () => {
	test('a required var that only the provider has stops being missing', () => {
		// The reported case: CONFIG_DIR is not in the editor, only in the 1Password
		// environment, so `docker compose config` flagged ${CONFIG_DIR:?...}.
		const out = withProviderKeysAsSet({}, ['CONFIG_DIR']);
		expect(Object.keys(out)).toEqual(['CONFIG_DIR']);
		expect(out.CONFIG_DIR).toBeTruthy();
	});

	test('the editor value wins over the placeholder', () => {
		const out = withProviderKeysAsSet({ CONFIG_DIR: '/srv/app' }, ['CONFIG_DIR']);
		expect(out.CONFIG_DIR).toBe('/srv/app');
	});

	test('an empty editor value is a deliberate setting, not an absence', () => {
		// Filling it would change what config sees for a var the user cleared on purpose.
		const out = withProviderKeysAsSet({ OPTIONAL: '' }, ['OPTIONAL']);
		expect(out.OPTIONAL).toBe('');
	});

	test('editor vars the provider does not supply are untouched', () => {
		const out = withProviderKeysAsSet({ LOCAL: 'x' }, ['REMOTE']);
		expect(out.LOCAL).toBe('x');
		expect(out.REMOTE).toBeTruthy();
	});

	test('no provider bound, or a failed probe, changes nothing', () => {
		// A failed probe yields an empty set, so vars stay missing rather than turning a
		// provider outage into a false pass - same rule the IN VAULT markers follow.
		expect(withProviderKeysAsSet({ A: '1' }, [])).toEqual({ A: '1' });
		expect(withProviderKeysAsSet({ A: '1' }, null)).toEqual({ A: '1' });
		expect(withProviderKeysAsSet({ A: '1' }, undefined)).toEqual({ A: '1' });
	});

	test('the caller-supplied envVars object is not mutated', () => {
		const envVars = { A: '1' };
		withProviderKeysAsSet(envVars, ['B']);
		expect(envVars).toEqual({ A: '1' });
	});

	test('a name that is not a valid shell variable is ignored', () => {
		// These reach `docker compose config`, so nothing odd gets injected.
		const out = withProviderKeysAsSet({}, ['9BAD', 'has-dash', 'has space', 'OK']);
		expect(Object.keys(out)).toEqual(['OK']);
	});

	test('names that steer the subprocess are never filled', () => {
		// The keys become the validation process's environment, so a placeholder under
		// PATH would lose the docker binary, and COMPOSE_* would change how config runs.
		const hostile = [
			'PATH',
			'HOME',
			'LD_PRELOAD',
			'DYLD_INSERT_LIBRARIES',
			'NODE_OPTIONS',
			'DOCKER_HOST',
			'DOCKER_CONFIG',
			'COMPOSE_FILE',
			'COMPOSE_PROJECT_NAME'
		];
		expect(Object.keys(withProviderKeysAsSet({}, hostile))).toEqual([]);
		expect(sanitizeProviderKeys(hostile)).toEqual([]);
	});

	test('an ordinary key that merely looks similar is still allowed', () => {
		expect(sanitizeProviderKeys(['PATH_PREFIX', 'HOMEPAGE_URL', 'DOCKER_IMAGE'])).toEqual([
			'PATH_PREFIX',
			'HOMEPAGE_URL',
			'DOCKER_IMAGE'
		]);
	});
});

describe('sanitizeProviderKeys', () => {
	test('keeps valid names and drops the rest', () => {
		expect(sanitizeProviderKeys(['OK', '_UNDER', 'A1', '1BAD', 'has-dash', ''])).toEqual([
			'OK',
			'_UNDER',
			'A1'
		]);
	});

	test('drops duplicates', () => {
		expect(sanitizeProviderKeys(['A', 'A', 'B'])).toEqual(['A', 'B']);
	});

	test('non-string entries and non-array input', () => {
		expect(sanitizeProviderKeys(['A', 42, null, { key: 'B' }])).toEqual(['A']);
		expect(sanitizeProviderKeys('A')).toEqual([]);
		expect(sanitizeProviderKeys(undefined)).toEqual([]);
		expect(sanitizeProviderKeys(null)).toEqual([]);
	});
});

describe('errors about the stand-in value', () => {
	// The placeholder satisfies ${VAR:?}, but compose type-checks some fields and no
	// single value fits them all: a port wants a number, init: wants a boolean. The real
	// value is a secret the preview never sees, so such a complaint says nothing about
	// whether the stack deploys.
	test('a typed-field complaint naming the placeholder is an artefact', () => {
		expect(isPlaceholderArtefact('invalid hostPort: dockhand-provider-value')).toBe(true);
		expect(
			isPlaceholderArtefact(
				'error while interpolating services.app.init: invalid boolean: dockhand-provider-value'
			)
		).toBe(true);
	});

	test('a real fault in the file is still reported', () => {
		expect(isPlaceholderArtefact('services.app.ports.0: invalid hostPort: abc')).toBe(false);
		expect(isPlaceholderArtefact('services must be a mapping')).toBe(false);
		expect(isPlaceholderArtefact('')).toBe(false);
	});
});
