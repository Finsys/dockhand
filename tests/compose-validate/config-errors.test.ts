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
