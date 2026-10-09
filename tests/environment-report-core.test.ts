import { describe, expect, test } from 'bun:test';
import {
	buildReport,
	includeChanges,
	imagesInUse,
	reportFilename,
	reportTier,
	reportToCSV,
	summarise,
	unscannedImages,
	type ReportEnvironment
} from '../src/lib/server/environment-report-core';

const env = (over: Partial<ReportEnvironment> = {}): ReportEnvironment => ({
	id: 1,
	name: 'prod',
	containers: [
		{ name: 'web', image: 'nginx:1.27', status: 'running', stack: 'site' },
		{ name: 'db', image: 'postgres:16', status: 'running', stack: 'site' }
	],
	stacks: ['site'],
	scans: [
		{ image: 'nginx:1.27', critical: 1, high: 2, medium: 3, low: 4, scannedAt: '2026-10-01T00:00:00Z' }
	],
	changes: [
		{ at: '2026-10-02T10:00:00Z', username: 'alice', action: 'deploy', entityType: 'stack', entityName: 'site' }
	],
	...over
});

const META = { generatedAt: '2026-10-03T12:00:00Z', appVersion: 'v1.0.51' };

/**
 * The change history is the audit log by another name, so the tier that cannot
 * open the audit page must not receive it through an export either.
 */
describe('tier decides whether changes are included', () => {
	test('enterprise gets the change history', () => {
		expect(includeChanges('enterprise')).toBe(true);
		const r = buildReport([env()], includeChanges('enterprise'), META);
		expect(r.includesChanges).toBe(true);
		expect(r.environments[0].changes).toHaveLength(1);
	});

	test('smb gets the report without it', () => {
		expect(includeChanges('smb')).toBe(false);
		const r = buildReport([env()], includeChanges('smb'), META);
		expect(r.includesChanges).toBe(false);
		expect(r.environments[0].changes).toBeUndefined();
	});

	test('the smb report still carries the inventory and the findings', () => {
		const r = buildReport([env()], includeChanges('smb'), META);
		expect(r.environments[0].containers).toHaveLength(2);
		expect(r.environments[0].scans).toHaveLength(1);
		expect(r.totals.critical).toBe(1);
	});

	test('an smb CSV has no Changes section', () => {
		const csv = reportToCSV(buildReport([env()], includeChanges('smb'), META));
		expect(csv).toContain('Containers');
		expect(csv).toContain('Vulnerabilities');
		expect(csv).not.toContain('Changes');
		expect(csv).not.toContain('alice');
	});

	test('an enterprise CSV has one', () => {
		const csv = reportToCSV(buildReport([env()], includeChanges('enterprise'), META));
		expect(csv).toContain('Changes');
		expect(csv).toContain('alice');
	});
});

/**
 * The tier is necessary but not sufficient: the change history is the audit log,
 * so the caller also has to hold the audit permission. buildReport takes the
 * decision rather than deriving it, so the report cannot claim a section it lacks.
 */
describe('the audit permission is separate from the tier', () => {
	test('enterprise WITHOUT the audit permission gets no changes', () => {
		const r = buildReport([env()], includeChanges('enterprise') && false, META);
		expect(r.includesChanges).toBe(false);
		expect(r.environments[0].changes).toBeUndefined();
		expect(reportToCSV(r)).not.toContain('alice');
	});

	test('the flag never claims a section the report does not carry', () => {
		for (const withChanges of [true, false]) {
			const r = buildReport([env()], withChanges, META);
			expect(r.includesChanges).toBe(withChanges);
			expect(r.environments[0].changes !== undefined).toBe(withChanges);
		}
	});
});

describe('an environment that could not be read', () => {
	test('is marked, so its empty lists do not read as "nothing deployed"', () => {
		const down: ReportEnvironment = {
			id: 2, name: 'staging', unreachable: true, unreachableReason: 'connect ECONNREFUSED',
			containers: [], stacks: [], scans: []
		};
		const r = buildReport([down], false, META);
		expect(r.environments[0].unreachable).toBe(true);
		expect(r.environments[0].unreachableReason).toContain('ECONNREFUSED');
	});

	test('is named in the CSV so a reader cannot miss it', () => {
		const down: ReportEnvironment = {
			id: 2, name: 'staging', unreachable: true, unreachableReason: 'connect ECONNREFUSED',
			containers: [], stacks: [], scans: []
		};
		const csv = reportToCSV(buildReport([env(), down], false, META));
		expect(csv).toContain('Environments that could not be read');
		expect(csv).toContain('staging');
		expect(csv).toContain('ECONNREFUSED');
	});

	test('a report with every environment readable has no such section', () => {
		expect(reportToCSV(buildReport([env()], false, META)))
			.not.toContain('Environments that could not be read');
	});

	test('does not silently add zeroes to the totals as if it were clean', () => {
		const down: ReportEnvironment = {
			id: 2, name: 'staging', unreachable: true,
			containers: [], stacks: [], scans: []
		};
		const t = summarise([env(), down]);
		// it still counts as an environment, but contributes no false "all clear"
		expect(t.environments).toBe(2);
		expect(t.unreachableEnvironments).toBe(1);
		// the down environment contributes nothing, so "no gaps" cannot be invented
		expect(t.containers).toBe(2);
		expect(t.unscannedImages).toBe(1);
	});
});

describe('images and coverage', () => {
	test('images are deduplicated in first-seen order', () => {
		const e = env({
			containers: [
				{ name: 'a', image: 'nginx:1.27', status: 'running', stack: null },
				{ name: 'b', image: 'nginx:1.27', status: 'running', stack: null },
				{ name: 'c', image: 'redis:7', status: 'running', stack: null }
			]
		});
		expect(imagesInUse(e.containers)).toEqual(['nginx:1.27', 'redis:7']);
	});

	test('an image nobody scanned is reported as a gap', () => {
		expect(unscannedImages(env())).toEqual(['postgres:16']);
	});

	test('a fully scanned environment has no gap', () => {
		const e = env({
			scans: [
				{ image: 'nginx:1.27', critical: 0, high: 0, medium: 0, low: 0, scannedAt: null },
				{ image: 'postgres:16', critical: 0, high: 0, medium: 0, low: 0, scannedAt: null }
			]
		});
		expect(unscannedImages(e)).toEqual([]);
	});
});

describe('totals across environments', () => {
	test('counts add up over every environment', () => {
		const t = summarise([env(), env({ id: 2, name: 'staging' })]);
		expect(t.environments).toBe(2);
		expect(t.containers).toBe(4);
		expect(t.scannedImages).toBe(2);
		expect(t.critical).toBe(2);
		expect(t.low).toBe(8);
		expect(t.unscannedImages).toBe(2);
	});

	test('an empty selection totals to zero rather than NaN', () => {
		const t = summarise([]);
		expect(t.environments).toBe(0);
		expect(t.critical).toBe(0);
		expect(t.unscannedImages).toBe(0);
	});
});

describe('the download filename', () => {
	test('names the scope and the day', () => {
		expect(reportFilename('prod', META.generatedAt, 'csv')).toBe('dockhand-report-prod-2026-10-03.csv');
	});

	test('a name with slashes or spaces cannot escape the filename', () => {
		expect(reportFilename('../../etc/passwd', META.generatedAt, 'json'))
			.toBe('dockhand-report-etc-passwd-2026-10-03.json');
		expect(reportFilename('a..b', META.generatedAt, 'csv'))
			.toBe('dockhand-report-a-b-2026-10-03.csv');
		expect(reportFilename('my env', META.generatedAt, 'csv'))
			.toBe('dockhand-report-my-env-2026-10-03.csv');
	});

	test('a crafted format cannot shape the header either', () => {
		expect(reportFilename('prod', META.generatedAt, 'csv"; x="')).toBe(
			'dockhand-report-prod-2026-10-03.txt'
		);
		expect(reportFilename('prod', META.generatedAt, '../x')).toBe(
			'dockhand-report-prod-2026-10-03.txt'
		);
	});

	test('a name made entirely of separators still yields a filename', () => {
		expect(reportFilename('///', META.generatedAt, 'csv'))
			.toBe('dockhand-report-environments-2026-10-03.csv');
	});
});

describe('csv safety', () => {
	test('a value that would run as a spreadsheet formula is neutralised', () => {
		const e = env({
			containers: [{ name: '=cmd()', image: 'x:1', status: 'running', stack: null }],
			scans: []
		});
		const csv = reportToCSV(buildReport([e], includeChanges('smb'), META));
		expect(csv).toContain("'=cmd()");
	});
});

/**
 * Which licences may have a report at all, and which one carries the change history.
 * Two callers ask this - the download route about the caller's licence, the scheduler
 * about the installation's - so a wrong answer here either hands the audit log to a
 * tier that did not pay for it, or refuses a customer who did.
 */
describe('reportTier', () => {
	test('a paid tier grants a report', () => {
		expect(reportTier('enterprise')).toBe('enterprise');
		expect(reportTier('smb')).toBe('smb');
	});

	test('no licence grants no report', () => {
		expect(reportTier(null)).toBeNull();
		expect(reportTier(undefined)).toBeNull();
		expect(reportTier('')).toBeNull();
		expect(reportTier('free')).toBeNull();
		expect(reportTier('trial')).toBeNull();
	});

	// An unknown or misspelled value must not be read as a tier: matching loosely here
	// is how an unlicensed instance would start exporting.
	test('a tier is matched exactly, not loosely', () => {
		expect(reportTier('ENTERPRISE')).toBeNull();
		expect(reportTier('Enterprise')).toBeNull();
		expect(reportTier('enterprise-trial')).toBeNull();
		expect(reportTier('smb-readonly')).toBeNull();
		expect(reportTier(' smb')).toBeNull();
	});

	// Only enterprise carries the audit log, whatever the report is otherwise allowed.
	test('only the enterprise tier carries the change history', () => {
		expect(includeChanges(reportTier('enterprise')!)).toBe(true);
		expect(includeChanges(reportTier('smb')!)).toBe(false);
	});
});
