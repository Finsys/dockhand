import { describe, test, expect } from 'bun:test';
import { filterFindings, flattenScansToFindings, sortFindings } from '../src/lib/utils/vulnerability';
import type { Finding } from '../src/lib/utils/vulnerability';
import { escapeCSV, rowsToCSV } from '../src/lib/server/csv';

const base = {
	cve: 'CVE-1',
	package: 'openssl',
	severity: 'high',
	imageName: 'nginx:latest',
	containers: [{ name: 'web-1' }],
	stacks: ['frontend']
};

describe('filterFindings', () => {
	const findings = [
		{ ...base, cve: 'CVE-1', severity: 'critical', imageName: 'nginx', containers: [{ name: 'web-1' }], stacks: ['frontend'] },
		{ ...base, cve: 'CVE-2', severity: 'low', imageName: 'redis', containers: [{ name: 'cache-1' }], stacks: ['backend'] },
		{ ...base, cve: 'CVE-3', severity: 'high', imageName: 'redis', containers: [], stacks: [] }
	];

	test('no filter returns all', () => {
		expect(filterFindings(findings, {})).toHaveLength(3);
	});
	test('severity filter', () => {
		expect(filterFindings(findings, { severities: ['critical'] }).map((f) => f.cve)).toEqual(['CVE-1']);
	});
	test('image filter', () => {
		expect(filterFindings(findings, { images: ['redis'] }).map((f) => f.cve)).toEqual(['CVE-2', 'CVE-3']);
	});
	test('container filter', () => {
		expect(filterFindings(findings, { containers: ['cache-1'] }).map((f) => f.cve)).toEqual(['CVE-2']);
	});
	test('stack filter', () => {
		expect(filterFindings(findings, { stacks: ['frontend'] }).map((f) => f.cve)).toEqual(['CVE-1']);
	});
	test('search matches cve/package/image/container/stack', () => {
		expect(filterFindings(findings, { q: 'cache-1' }).map((f) => f.cve)).toEqual(['CVE-2']);
		expect(filterFindings(findings, { q: 'frontend' }).map((f) => f.cve)).toEqual(['CVE-1']);
		expect(filterFindings(findings, { q: 'redis' }).map((f) => f.cve)).toEqual(['CVE-2', 'CVE-3']);
	});
	test('filters combine (AND)', () => {
		expect(filterFindings(findings, { images: ['redis'], severities: ['high'] }).map((f) => f.cve)).toEqual(['CVE-3']);
	});
	test('empty arrays are treated as no filter', () => {
		expect(filterFindings(findings, { severities: [], images: [] })).toHaveLength(3);
	});
});

describe('flattenScansToFindings', () => {
	test('flattens and dedupes by image|cve|package|version', () => {
		const scans = [
			{
				imageId: 'sha256:a', imageName: 'nginx', scannedAt: 't1',
				vulnerabilities: [
					{ id: 'CVE-1', severity: 'high', package: 'p', version: '1', fixedVersion: '2', link: 'l' },
					{ id: 'CVE-1', severity: 'high', package: 'p', version: '1' } // duplicate
				]
			}
		];
		const findings = flattenScansToFindings(scans);
		expect(findings).toHaveLength(1);
		expect(findings[0].cve).toBe('CVE-1');
		expect(findings[0].fixedVersion).toBe('2');
		expect(findings[0].imageId).toBe('sha256:a');
	});

	test('parses legacy double-encoded vulnerabilities string', () => {
		const scans = [
			{ imageId: 'sha256:b', imageName: 'redis', scannedAt: 't', vulnerabilities: JSON.stringify([{ id: 'CVE-9', severity: 'low', package: 'q', version: '3' }]) }
		];
		const findings = flattenScansToFindings(scans);
		expect(findings).toHaveLength(1);
		expect(findings[0].cve).toBe('CVE-9');
	});

	test('tolerates missing/invalid vulnerabilities', () => {
		expect(flattenScansToFindings([{ imageId: 'x', imageName: 'y', scannedAt: 't', vulnerabilities: null }])).toHaveLength(0);
		expect(flattenScansToFindings([{ imageId: 'x', imageName: 'y', scannedAt: 't', vulnerabilities: 'not-json' }])).toHaveLength(0);
	});
});

describe('sortFindings', () => {
	function f(over: Partial<Finding>): Finding {
		return {
			key: 'k', cve: 'CVE-0', package: 'pkg', severity: 'low', installedVersion: '1.0',
			fixedVersion: '', imageId: 'sha256:x', imageName: 'img', description: '', link: '',
			scannedAt: '', containers: [], stacks: [], ...over
		} as Finding;
	}

	test('severity: rank is critical=0..low=3, so asc lists critical first', () => {
		const rows = [f({ severity: 'low' }), f({ severity: 'critical' }), f({ severity: 'medium' }), f({ severity: 'high' })];
		expect(sortFindings(rows, 'severity', 'asc').map((r) => r.severity)).toEqual(['critical', 'high', 'medium', 'low']);
		expect(sortFindings(rows, 'severity', 'desc').map((r) => r.severity)).toEqual(['low', 'medium', 'high', 'critical']);
	});

	test('cve: plain string order', () => {
		const rows = [f({ cve: 'CVE-3' }), f({ cve: 'CVE-1' }), f({ cve: 'CVE-2' })];
		expect(sortFindings(rows, 'cve', 'asc').map((r) => r.cve)).toEqual(['CVE-1', 'CVE-2', 'CVE-3']);
	});

	test('installed: numeric-aware version compare (1.2.10 > 1.2.9)', () => {
		const rows = [f({ installedVersion: '1.2.9' }), f({ installedVersion: '1.2.10' }), f({ installedVersion: '1.2.1' })];
		expect(sortFindings(rows, 'installed', 'asc').map((r) => r.installedVersion)).toEqual(['1.2.1', '1.2.9', '1.2.10']);
	});

	test('container: sorts by the alphabetically-first container name (min of the list)', () => {
		const rows = [
			f({ cve: 'A', containers: [{ name: 'zeta' }, { name: 'beta' }] }), // min = beta
			f({ cve: 'B', containers: [{ name: 'alpha' }] }),                   // min = alpha
			f({ cve: 'C', containers: [] })                                     // min = '' (first)
		];
		expect(sortFindings(rows, 'container', 'asc').map((r) => r.cve)).toEqual(['C', 'B', 'A']);
	});

	test('stack: sorts by the alphabetically-first stack; empty sorts first', () => {
		const rows = [
			f({ cve: 'A', stacks: ['web', 'api'] }), // min = api
			f({ cve: 'B', stacks: ['db'] }),         // min = db
			f({ cve: 'C', stacks: [] })              // min = ''
		];
		expect(sortFindings(rows, 'stack', 'asc').map((r) => r.cve)).toEqual(['C', 'A', 'B']);
	});

	test('returns a new array and does not mutate the input', () => {
		const rows = [f({ cve: 'CVE-2' }), f({ cve: 'CVE-1' })];
		const sorted = sortFindings(rows, 'cve', 'asc');
		expect(sorted).not.toBe(rows);
		expect(rows.map((r) => r.cve)).toEqual(['CVE-2', 'CVE-1']); // original order intact
	});
});

describe('escapeCSV — plain values', () => {
	test('leaves a plain string untouched', () => {
		expect(escapeCSV('plain')).toBe('plain');
		expect(escapeCSV('CVE-2024-1234')).toBe('CVE-2024-1234');
		expect(escapeCSV('nginx:1.25.3')).toBe('nginx:1.25.3');
	});

	test('renders positive numbers as their string form, unquoted', () => {
		expect(escapeCSV(42)).toBe('42');
		expect(escapeCSV(0)).toBe('0');
		expect(escapeCSV(3.14)).toBe('3.14');
	});

	test('a NEGATIVE number stringifies to a leading "-", so it is prefixed', () => {
		// String(-5) === "-5" starts with '-', a formula trigger. Prefixing is the
		// safe, intended outcome (the cell stays human-readable as '-5).
		expect(escapeCSV(-5)).toBe("'-5");
	});

	test('maps null/undefined to an empty cell', () => {
		expect(escapeCSV(null)).toBe('');
		expect(escapeCSV(undefined)).toBe('');
	});

	test('leaves an empty string empty', () => {
		expect(escapeCSV('')).toBe('');
	});
});

describe('escapeCSV — RFC-4180 quoting', () => {
	test('quotes values containing a comma', () => {
		expect(escapeCSV('a,b')).toBe('"a,b"');
	});

	test('quotes and doubles embedded quotes', () => {
		expect(escapeCSV('say "hi"')).toBe('"say ""hi"""');
		expect(escapeCSV('"')).toBe('""""'); // one quote -> quoted + doubled
	});

	test('quotes values containing a newline (LF)', () => {
		expect(escapeCSV('line1\nline2')).toBe('"line1\nline2"');
	});

	test('quotes values containing a carriage return (CR)', () => {
		// CR is also a row-break in many CSV parsers; must be quoted. It is also a
		// leading-CR formula-injection trigger, so it additionally gets the ' prefix.
		expect(escapeCSV('a\rb')).toBe('"a\rb"');
	});

	test('does not quote a value with no special characters', () => {
		expect(escapeCSV('no-specials_here.123')).toBe('no-specials_here.123');
	});
});

describe('escapeCSV — formula-injection neutralization', () => {
	test('prefixes a leading = with a single quote', () => {
		expect(escapeCSV('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
		expect(escapeCSV('=1+1')).toBe("'=1+1");
	});

	test('prefixes leading +, -, @ (spreadsheet formula starters)', () => {
		expect(escapeCSV('+1')).toBe("'+1");
		expect(escapeCSV('-1+2')).toBe("'-1+2");
		expect(escapeCSV('@SUM')).toBe("'@SUM");
	});

	test('prefixes a leading tab (payload smuggling via whitespace)', () => {
		// Tab is a formula trigger (gets the ' prefix) but NOT an RFC-4180 quote
		// trigger, so no surrounding quotes are added.
		expect(escapeCSV('\t=cmd')).toBe("'\t=cmd");
		expect(escapeCSV('\thello')).toBe("'\thello");
	});

	test('a leading CR is prefixed AND quoted (CR is both triggers)', () => {
		expect(escapeCSV('\rhello')).toBe('"\'\rhello"');
	});

	test('only the FIRST character matters — interior symbols are safe', () => {
		expect(escapeCSV('a=b')).toBe('a=b');
		expect(escapeCSV('nginx-1.25')).toBe('nginx-1.25');
		expect(escapeCSV('user@host')).toBe('user@host');
	});

	test('injection + RFC-4180: a leading = with a comma is BOTH prefixed and quoted', () => {
		// e.g. an attacker-crafted image name like "=HYPERLINK(x),evil"
		expect(escapeCSV('=cmd,arg')).toBe('"\'=cmd,arg"');
	});

	test('injection char that also needs quoting for an embedded quote', () => {
		expect(escapeCSV('=say"hi"')).toBe('"\'=say""hi"""');
	});
});

describe('rowsToCSV', () => {
	test('builds a header row plus escaped data rows', () => {
		const csv = rowsToCSV(['A', 'B'], [['x', 'y,z'], [1, null]]);
		expect(csv).toBe('A,B\nx,"y,z"\n1,');
	});

	test('emits just the header when there are no rows', () => {
		expect(rowsToCSV(['A', 'B'], [])).toBe('A,B');
	});

	test('escapes injection payloads inside data rows', () => {
		const csv = rowsToCSV(['CVE', 'Image'], [['CVE-1', '=IMPORTXML(1)']]);
		expect(csv).toBe("CVE,Image\nCVE-1,'=IMPORTXML(1)");
	});

	test('handles mixed null / number / string cells per row', () => {
		const csv = rowsToCSV(['A', 'B', 'C'], [[null, 7, 'hi'], ['', undefined, 'a,b']]);
		expect(csv).toBe('A,B,C\n,7,hi\n,,"a,b"');
	});

	test('does not escape header cells (headers are fixed, trusted labels)', () => {
		// Sanity: headers are joined verbatim; callers pass safe constant labels.
		const csv = rowsToCSV(['Fixed Version', 'Link'], [['1.2.3', 'http://x']]);
		expect(csv.split('\n')[0]).toBe('Fixed Version,Link');
	});
});
