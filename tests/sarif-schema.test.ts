import { describe, test, expect } from 'bun:test';
import { findingsToSarif } from '../src/lib/utils/sarif';
import type { Finding } from '../src/lib/utils/vulnerability';

// Structural validation of the generated SARIF 2.1.0 so the generator can't drift
// out of spec. This used to compile the official OASIS schema with ajv-draft-04,
// but that pulls in ajv as an OPTIONAL peer dependency which bun resolves
// unreliably in CI (files on disk, yet require('ajv/dist/core') throws) — a
// recurring flake that failed the whole unit-test step. We assert the same
// load-bearing SARIF invariants directly, with zero external dependencies.

const SARIF_LEVELS = new Set(['none', 'note', 'warning', 'error']);

function finding(over: Partial<Finding> = {}): Finding {
	return {
		key: 'k', cve: 'CVE-2024-0001', package: 'openssl', severity: 'high',
		installedVersion: '1.1.1', fixedVersion: '1.1.1w',
		imageId: 'sha256:abc', imageName: 'nginx:latest',
		description: 'A flaw', link: 'https://nvd.nist.gov/vuln/detail/CVE-2024-0001',
		scannedAt: '2026-07-01T00:00:00.000Z', containers: [{ id: 'c', name: 'web-1' }], stacks: ['frontend'],
		...over
	};
}

/**
 * Assert the document is a spec-shaped SARIF 2.1.0 log. Checks the required
 * structure the OASIS schema enforces: the version/`runs` envelope, each run's
 * tool.driver + rules, each result's ruleId/level/message, the `level` enum, and
 * referential integrity (every result.ruleId is declared in driver.rules).
 */
function expectValid(doc: any) {
	// Envelope
	expect(doc).toBeTypeOf('object');
	expect(doc.version).toBe('2.1.0');
	expect(typeof doc.$schema).toBe('string');
	expect(Array.isArray(doc.runs)).toBe(true);

	for (const run of doc.runs) {
		// tool.driver is required, with a name and a rules array
		expect(run.tool).toBeTypeOf('object');
		const driver = run.tool.driver;
		expect(driver).toBeTypeOf('object');
		expect(typeof driver.name).toBe('string');
		expect(driver.name.length).toBeGreaterThan(0);
		expect(Array.isArray(driver.rules)).toBe(true);

		const ruleIds = new Set<string>();
		for (const rule of driver.rules) {
			expect(typeof rule.id).toBe('string');
			expect(rule.id.length).toBeGreaterThan(0);
			expect(rule.shortDescription?.text).toBeTypeOf('string');
			// defaultConfiguration.level, when present, must be a valid SARIF level
			if (rule.defaultConfiguration?.level !== undefined) {
				expect(SARIF_LEVELS.has(rule.defaultConfiguration.level)).toBe(true);
			}
			expect(ruleIds.has(rule.id)).toBe(false); // no duplicate rule ids
			ruleIds.add(rule.id);
		}

		// results
		expect(Array.isArray(run.results)).toBe(true);
		for (const res of run.results) {
			expect(typeof res.ruleId).toBe('string');
			expect(SARIF_LEVELS.has(res.level)).toBe(true);
			expect(res.message?.text).toBeTypeOf('string');
			// referential integrity: a result must reference a declared rule
			expect(ruleIds.has(res.ruleId)).toBe(true);
		}
	}
}

describe('findingsToSarif schema validity', () => {
	test('empty findings produce schema-valid SARIF', () => {
		const doc = findingsToSarif([]);
		expectValid(doc);
		expect(doc.runs[0].results).toEqual([]);
	});

	test('single finding is schema-valid', () => {
		expectValid(findingsToSarif([finding()]));
	});

	test('all severities produce schema-valid SARIF', () => {
		expectValid(findingsToSarif([
			finding({ cve: 'C1', severity: 'critical' }),
			finding({ cve: 'C2', severity: 'high' }),
			finding({ cve: 'C3', severity: 'medium' }),
			finding({ cve: 'C4', severity: 'low' }),
			finding({ cve: 'C5', severity: 'negligible' }),
			finding({ cve: 'C6', severity: 'unknown' })
		]));
	});

	test('findings with no fix / no link / no containers are schema-valid', () => {
		expectValid(findingsToSarif([
			finding({ fixedVersion: '', link: undefined, containers: undefined, stacks: undefined, description: undefined })
		]));
	});

	test('duplicate CVEs across packages stay schema-valid', () => {
		expectValid(findingsToSarif([
			finding({ cve: 'CVE-DUP', package: 'a' }),
			finding({ cve: 'CVE-DUP', package: 'b' })
		]));
	});
});
