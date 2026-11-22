// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import { parseConfigErrors, composeConfigEnv } from '../../src/lib/server/compose-validate/effective-compose';
import { readFileSync } from 'node:fs';

describe('parseConfigErrors (docker compose config stderr)', () => {
	test('a schema error becomes one COMPOSE_SCHEMA_ERROR finding', () => {
		const stderr = `validating /tmp/x/docker-compose.yml: services.web.ports.0 must be a string or number`;
		const out = parseConfigErrors(stderr);
		expect(out).toHaveLength(1);
		expect(out[0].ruleId).toBe('COMPOSE_SCHEMA_ERROR');
		expect(out[0].severity).toBe('error');
		expect(out[0].message).toContain('services.web.ports.0');
		expect(out[0].message).not.toContain('validating');
	});

	test('a line number in the message is lifted to .line', () => {
		const out = parseConfigErrors('yaml: line 7: mapping values are not allowed here');
		expect(out[0].line).toBe(7);
	});

	test('duplicate error lines are collapsed', () => {
		const out = parseConfigErrors('error: boom\nerror: boom\n');
		expect(out).toHaveLength(1);
		expect(out[0].message).toBe('boom');
	});

	test('empty stderr still yields a single generic error', () => {
		const out = parseConfigErrors('   \n  \n');
		expect(out).toHaveLength(1);
		expect(out[0].ruleId).toBe('COMPOSE_SCHEMA_ERROR');
	});

	test('blank lines are ignored', () => {
		const out = parseConfigErrors('\n\nservices.db.image is required\n\n');
		expect(out).toHaveLength(1);
		expect(out[0].message).toBe('services.db.image is required');
	});

	describe('complaints about the stand-in for a secret', () => {
		// Previewing a stack whose values come from a provider substitutes a placeholder,
		// and config then objects to the placeholder rather than to the file. Reporting
		// that would tell the user their compose is broken when it is not.
		//
		// The stand-in is spelled out rather than imported: these pin the bytes compose
		// echoes back, and comparing the constant against itself would assert nothing.
		test('a stderr that is only placeholder complaints reports nothing', () => {
			const stderr =
				'validating /tmp/x/docker-compose.yml: services.web.ports.0: invalid hostPort: dockhand-provider-value';
			expect(parseConfigErrors(stderr)).toEqual([]);
		});

		test('a real error alongside a placeholder complaint is still reported', () => {
			const stderr = [
				'services.web.ports.0: invalid hostPort: dockhand-provider-value',
				'services.db.image is required'
			].join('\n');
			const out = parseConfigErrors(stderr);
			expect(out).toHaveLength(1);
			expect(out[0].message).toBe('services.db.image is required');
		});

		test('the generic fallback is not raised for a placeholder-only failure', () => {
			// Without the placeholder branch the empty finding list would fall through to
			// "rejected the file (no detail provided)", which is the same false alarm.
			const out = parseConfigErrors('invalid hostPort: dockhand-provider-value');
			expect(out).toEqual([]);
		});

		test('the match is on the name alone, so any message carrying it is dropped', () => {
			// isPlaceholderArtefact is a substring test, which means a real complaint that
			// merely names the stand-in is suppressed too. Pinned rather than asserted as
			// desirable: a preview cannot tell the two apart, and staying quiet about a
			// value the user did not write beats crying wolf on every previewed stack.
			expect(parseConfigErrors('services.db.image is required: dockhand-provider-value')).toEqual(
				[]
			);
		});

		test('an error naming no stand-in is reported as usual', () => {
			const out = parseConfigErrors('services.web.environment.API_KEY is required');
			expect(out).toHaveLength(1);
			expect(out[0].ruleId).toBe('COMPOSE_SCHEMA_ERROR');
		});
	});
});

// The validate route copies the request's envVars into the `docker compose config` child.
// Keys that steer which binary runs must not get through, as on the deploy spawn.
describe('composeConfigEnv', () => {
	test('strips loader, PATH, DOCKER_* and file-selecting COMPOSE_* overrides and keeps ordinary stack vars', () => {
		const env = composeConfigEnv({
			PATH: '/scratch/evil',
			LD_PRELOAD: '/scratch/evil.so',
			DOCKER_CONFIG: '/scratch/cfg',
			DOCKER_HOST: 'tcp://10.0.0.9:2375',
			NODE_OPTIONS: '--require /scratch/x.js',
			COMPOSE_ENV_FILES: '/app/data/stacks/other/.env',
			COMPOSE_FILE: '/app/data/stacks/other/compose.yml',
			DOMAIN_NAME: 'example.com',
			MY_COMPOSE_TAG: 'v1',
			COMPOSE_PROFILES: 'full',
			COMPOSE_TAG: '1.2'
		});
		expect(env.PATH).toBe(process.env.PATH || '/usr/local/bin:/usr/bin:/bin');
		expect(env.DOMAIN_NAME).toBe('example.com');
		expect(env.MY_COMPOSE_TAG).toBe('v1');
		// Profiles and COMPOSE_-named interpolation decide what config renders.
		expect(env.COMPOSE_PROFILES).toBe('full');
		expect(env.COMPOSE_TAG).toBe('1.2');
		for (const k of ['LD_PRELOAD', 'DOCKER_CONFIG', 'DOCKER_HOST', 'NODE_OPTIONS', 'COMPOSE_ENV_FILES', 'COMPOSE_FILE']) {
			expect(env[k]).toBeUndefined();
		}
	});

	test('no vars gives just PATH', () => {
		expect(Object.keys(composeConfigEnv())).toEqual(['PATH']);
	});
});

// renderEffectiveCompose spawns docker, so its wiring is pinned in the source: the child
// gets the filtered env, and a compose reading outside the scratch dir never reaches it.
describe('renderEffectiveCompose wiring', () => {
	const src = readFileSync('src/lib/server/compose-validate/effective-compose.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

	test('the docker child env is composeConfigEnv, and nothing else sets one', () => {
		expect(src).toContain('env: composeConfigEnv(envVars)');
		expect(src.match(/\benv:/g)).toHaveLength(1);
	});

	test('the scratch-dir check reads its own strict load and returns before config is spawned', () => {
		expect(src).toContain('const doc = loadForScratchCheck(composeContent);');
		expect(src).not.toContain('parseCompose(');
		const gate = src.search(/^\s*if \(!doc \|\| referencesOutsideScratchDir\(doc\)\) return \{ ok: false, findings: \[\] \};/m);
		expect(gate).toBeGreaterThan(-1);
		expect(gate).toBeLessThan(src.indexOf('await execDocker('));
	});
});
