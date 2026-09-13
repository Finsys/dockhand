// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import { parseConfigErrors } from '../../src/lib/server/compose-validate/effective-compose';

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
});
