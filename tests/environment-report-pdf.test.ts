/**
 * The PDF report's pure pieces: what the headline figures say, and how a name too long for
 * its column is shortened. The rendering itself is covered by the integration test, which
 * reads a real document back.
 */
import { describe, test, expect } from 'bun:test';
import { headlineFigures, reportPdfFilename, fitToWidth } from '../src/lib/server/environment-report-pdf';
import type { EnvironmentReport } from '../src/lib/server/environment-report-core';

const report = (over: Partial<EnvironmentReport['totals']> = {}, rest: Partial<EnvironmentReport> = {}): EnvironmentReport => ({
	generatedAt: '2026-10-08T06:40:00.000Z',
	appVersion: 'v1.0.52',
	environments: [],
	includesChanges: false,
	totals: {
		environments: 2, containers: 41, stacks: 9, scannedImages: 3,
		critical: 0, high: 0, medium: 0, low: 0,
		unreachableEnvironments: 0, unscannedImages: 0,
		...over
	} as EnvironmentReport['totals'],
	...rest
});

describe('headlineFigures', () => {
	test('reports the totals in the order an auditor asks for them', () => {
		const labels = headlineFigures(report()).map((f) => f.label);
		expect(labels).toEqual(['Environments', 'Containers', 'Stacks', 'Scanned images', 'Critical', 'High']);
	});

	test('carries the totals through unchanged', () => {
		const figures = headlineFigures(report());
		expect(figures.find((f) => f.label === 'Containers')?.value).toBe(41);
		expect(figures.find((f) => f.label === 'Stacks')?.value).toBe(9);
	});

	// A zero is the good news, so it must not be dressed up as a warning.
	test('a severity of zero is not coloured', () => {
		const figures = headlineFigures(report({ critical: 0, high: 0 }));
		expect(figures.find((f) => f.label === 'Critical')?.color).toBeUndefined();
		expect(figures.find((f) => f.label === 'High')?.color).toBeUndefined();
	});

	test('a severity above zero is coloured, and the two differ', () => {
		const figures = headlineFigures(report({ critical: 1, high: 6 }));
		const critical = figures.find((f) => f.label === 'Critical')?.color;
		const high = figures.find((f) => f.label === 'High')?.color;
		expect(critical).toBeTruthy();
		expect(high).toBeTruthy();
		expect(critical).not.toBe(high);
	});

	// The near miss: only the two severities are coloured, never a count.
	test('a large container count stays plain', () => {
		const figures = headlineFigures(report({ containers: 9999 }));
		expect(figures.find((f) => f.label === 'Containers')?.color).toBeUndefined();
	});
});

describe('reportPdfFilename', () => {
	test('names the environment and the date it covers', () => {
		expect(reportPdfFilename(report(), 'anton')).toBe('dockhand-report-anton-2026-10-08.pdf');
	});

	test('a report over every environment says so', () => {
		expect(reportPdfFilename(report(), null)).toBe('dockhand-report-all-environments-2026-10-08.pdf');
		expect(reportPdfFilename(report())).toBe('dockhand-report-all-environments-2026-10-08.pdf');
	});

	// An environment is named by a person, so the name has to survive becoming a filename
	// without needing quotes or escaping anywhere it is later used.
	test('a name that is not filename-safe is made safe', () => {
		expect(reportPdfFilename(report(), 'prod/eu west')).toBe('dockhand-report-prod-eu-west-2026-10-08.pdf');
		expect(reportPdfFilename(report(), '../../etc/passwd')).toBe('dockhand-report-etc-passwd-2026-10-08.pdf');
		expect(reportPdfFilename(report(), 'a:b*c?d')).toBe('dockhand-report-a-b-c-d-2026-10-08.pdf');
	});

	test('a name made entirely of unusable characters still yields a filename', () => {
		expect(reportPdfFilename(report(), '///')).toBe('dockhand-report-all-2026-10-08.pdf');
	});

	test('a missing generation date does not produce a half-written name', () => {
		expect(reportPdfFilename(report({}, { generatedAt: '' }), 'anton')).toBe('dockhand-report-anton-report.pdf');
	});
});

/**
 * A cell is sized in POINTS but a name is counted in characters, and at 7.5pt a `W` is
 * over twice the width of an `i`. pdfkit does not clip - `lineBreak: false` still wraps,
 * and a wrapped cell prints over the rows beneath it - so the fit is decided here and
 * the invariant is simply that the result never measures wider than the column.
 *
 * The widths are faked rather than measured so the test needs no font: `W` counts 10,
 * every other character 1, which reproduces the proportional-width problem exactly.
 */
function fakeDoc(): PDFKit.PDFDocument {
	return {
		widthOfString: (s: string) =>
			[...s].reduce((sum, ch) => sum + (ch === 'W' ? 10 : 1), 0)
	} as unknown as PDFKit.PDFDocument;
}

describe('fitToWidth', () => {
	const doc = fakeDoc();
	const width = (s: string) => doc.widthOfString(s);

	test('a value that already fits is returned untouched', () => {
		expect(fitToWidth(doc, 'nginx', 40)).toBe('nginx');
		expect(fitToWidth(doc, '', 40)).toBe('');
	});

	test('the result never measures wider than the column', () => {
		const samples = [
			'W'.repeat(60),
			'i'.repeat(60),
			'WiWiWiWiWiWiWiWiWiWi',
			'ghcr.io/immich-app/immich-machine-learning:v1.119.0',
			'registry.gitlab.com/MyOrg/WWW-Frontend:latest'
		];
		for (const avail of [0, 1, 2, 3, 4, 5, 8, 20, 50, 142, 182]) {
			for (const value of samples) {
				const out = fitToWidth(doc, value, avail);
				expect(width(out)).toBeLessThanOrEqual(avail);
			}
		}
	});

	// A column of capitals is the case a character budget gets wrong: 20 `W`s measure 200,
	// so only a couple can survive a 30-point column however many characters would fit.
	test('a wide-glyph value is shortened by width, not by character count', () => {
		const out = fitToWidth(doc, 'W'.repeat(20), 30);
		expect(width(out)).toBeLessThanOrEqual(30);
		expect(out.length).toBeLessThan(20);
	});

	test('both ends of the value are kept, so a reference stays identifiable', () => {
		const out = fitToWidth(doc, 'registry.example.com/team/app:1.2.3', 20);
		expect(out).toContain('...');
		expect(out.startsWith('r')).toBe(true);
		expect(out.endsWith('3')).toBe(true);
		expect(width(out)).toBeLessThanOrEqual(20);
	});

	test('a column too narrow for the ellipsis falls back to whatever fits', () => {
		expect(fitToWidth(doc, 'abcdef', 2)).toBe('ab');
		expect(fitToWidth(doc, 'abcdef', 0)).toBe('');
		expect(fitToWidth(doc, 'W'.repeat(5), 2)).toBe('');
	});
});
