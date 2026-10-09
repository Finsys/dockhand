/**
 * Render an environment state report as a PDF.
 *
 * The report is read by someone who has to answer "what was running, and what did we know
 * about it" - an auditor, or the person who has to produce something for one. So the layout
 * is plain: a totals row they can quote, then one table per environment, then the scans.
 *
 * pdfkit is loaded on first use rather than at import. It costs ~8 MB of heap and ~80 ms,
 * which every install would otherwise pay at boot for a feature most never run.
 */

import type { EnvironmentReport, ReportEnvironment, ReportImageScan } from './environment-report-core';

const BRAND_INK = '#111827';
const MUTED = '#6b7280';
const RULE = '#e5e7eb';
const STRIPE = '#fcfcfd';
const HEAD_BG = '#f8fafc';
const CRITICAL = '#dc2626';
const HIGH = '#ea580c';
const RUNNING = '#16a34a';
const DIM = '#9ca3af';

const MARGIN = 48;
const ROW_H = 13;
/** Keep a row off the footer rule; a row drawn below it silently adds a page. */
const BOTTOM_GUARD = 72;

interface Column<T> {
	heading: string;
	/** Width in points. The widths of a table's columns should fill the text column. */
	width: number;
	value: (row: T) => string;
	/** Render in the monospaced face, for an image reference or a digest. */
	mono?: boolean;
	color?: (row: T) => string;
}

/**
 * The logo drawn on the PDF's first page. Read once; a missing file costs the logo,
 * not the report.
 *
 * The built image ships `build/client`, not `static`, so the built location is tried
 * first and the source tree second - otherwise the logo appears in development and is
 * silently absent in production.
 */
let logoCache: string | null | undefined;
export async function readReportLogo(): Promise<string | null> {
	if (logoCache !== undefined) return logoCache;
	const { readFile } = await import('node:fs/promises');
	const { join } = await import('node:path');
	for (const dir of ['build/client', 'static']) {
		try {
			logoCache = await readFile(join(process.cwd(), dir, 'logo.svg'), 'utf8');
			return logoCache;
		} catch {
			// try the next location
		}
	}
	logoCache = null;
	return logoCache;
}

/**
 * Shorten a value until it actually fits `avail` POINTS in the current font.
 *
 * A character budget cannot answer this: at 7.5pt Helvetica a `W` is over twice the
 * width of an `i`, so a cell sized for a registry path overflows on a name in capitals.
 * `lineBreak: false` does not clip - pdfkit still wraps - and an overflowing cell prints
 * on top of the rows below it, so the fit has to be decided here.
 *
 * The middle is dropped rather than the end: the head and the tail of an image
 * reference are what identify it.
 */
export function fitToWidth(doc: PDFKit.PDFDocument, value: string, avail: number): string {
	// Redundant with the fallback below, which also yields '' - kept as a cheap bound so
	// a zero-width column cannot walk the string one character at a time.
	if (avail <= 0) return '';
	if (doc.widthOfString(value) <= avail) return value;

	const ell = '...';
	if (doc.widthOfString(ell) > avail) {
		// Narrower than the ellipsis itself: take whatever single characters fit.
		let out = '';
		for (const ch of value) {
			if (doc.widthOfString(out + ch) > avail) break;
			out += ch;
		}
		return out;
	}

	// Grow the tail and the head in turn, tail first, so neither end can starve: filling
	// the head to exhaustion would leave a value ending in the ellipsis and drop the tag,
	// which is the half that distinguishes two builds of the same image.
	let head = 0;
	let tail = 0;
	let grewTail: boolean = true;
	for (;;) {
		if (head + tail >= value.length) break;
		const candidate = (h: number, t: number) =>
			value.slice(0, h) + ell + value.slice(value.length - t);
		// Alternate; on the turn one end cannot grow, let the other try before giving up.
		const order: boolean[] = grewTail ? [false, true] : [true, false];
		let grew = false;
		for (const growTail of order) {
			const next = growTail ? candidate(head, tail + 1) : candidate(head + 1, tail);
			if (doc.widthOfString(next) <= avail) {
				if (growTail) tail++;
				else head++;
				grewTail = growTail;
				grew = true;
				break;
			}
		}
		if (!grew) break;
	}
	return value.slice(0, head) + ell + value.slice(value.length - tail);
}

/** The totals an auditor quotes, in the order they are usually asked for. */
export function headlineFigures(report: EnvironmentReport): Array<{ label: string; value: number; color?: string }> {
	const t = report.totals;
	return [
		{ label: 'Environments', value: t.environments },
		{ label: 'Containers', value: t.containers },
		{ label: 'Stacks', value: t.stacks },
		{ label: 'Scanned images', value: t.scannedImages },
		{ label: 'Critical', value: t.critical, color: t.critical > 0 ? CRITICAL : undefined },
		{ label: 'High', value: t.high, color: t.high > 0 ? HIGH : undefined }
	];
}

/** A name for the downloaded file that sorts by date and never needs quoting. */
export function reportPdfFilename(report: EnvironmentReport, envName?: string | null): string {
	const date = (report.generatedAt || '').slice(0, 10) || 'report';
	// Collapse every run of unusable characters, then strip the leading dots a traversal
	// would leave behind - this name becomes a mail attachment, not just a header.
	const scope = (envName || 'all-environments')
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.replace(/\.{2,}/g, '')
		.replace(/^[-.]+|[-.]+$/g, '')
		.replace(/-{2,}/g, '-');
	return `dockhand-report-${scope || 'all'}-${date}.pdf`;
}

export async function buildReportPdf(report: EnvironmentReport, logoSvg?: string | null): Promise<Buffer> {
	const [{ default: PDFDocument }, svgToPdf] = await Promise.all([
		import('pdfkit'),
		import('svg-to-pdfkit').then((m) => m.default)
	]);

	const doc = new PDFDocument({
		size: 'A4',
		margin: MARGIN,
		bufferPages: true,
		info: {
			Title: 'Dockhand environment state report',
			Author: 'Dockhand',
			Creator: `Dockhand ${report.appVersion}`,
			CreationDate: new Date(report.generatedAt)
		}
	});

	const chunks: Buffer[] = [];
	doc.on('data', (c: Buffer) => chunks.push(c));
	const done = new Promise<Buffer>((resolve, reject) => {
		doc.on('end', () => resolve(Buffer.concat(chunks)));
		doc.on('error', reject);
	});

	const left = MARGIN;
	const right = doc.page.width - MARGIN;
	const width = right - left;

	drawHeader(doc, svgToPdf, report, logoSvg, left, right, width);
	drawFigures(doc, report, left, width);

	for (const env of report.environments) {
		drawEnvironment(doc, env, left, width);
	}
	drawScans(doc, report, left, width);
	if (report.includesChanges) drawChanges(doc, report, left, width);

	drawFooters(doc, left, width);
	doc.end();
	return done;
}

function drawHeader(
	doc: PDFKit.PDFDocument,
	svgToPdf: (doc: PDFKit.PDFDocument, svg: string, x: number, y: number, opts?: object) => void,
	report: EnvironmentReport,
	logoSvg: string | null | undefined,
	left: number,
	right: number,
	width: number
) {
	let textLeft = left;
	if (logoSvg) {
		try {
			svgToPdf(doc, logoSvg, left, MARGIN - 4, { width: 38, height: 38 });
			textLeft = left + 50;
		} catch {
			// A logo that will not parse is not worth failing a report over.
		}
	}
	doc.fillColor(BRAND_INK).font('Helvetica-Bold').fontSize(17)
		.text('Environment state report', textLeft, MARGIN, { lineBreak: false });

	const when = (report.generatedAt || '').replace('T', ' ').slice(0, 16);
	const envCount = report.environments.length;
	const scope = `${envCount} ${envCount === 1 ? 'environment' : 'environments'}`;
	doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
		.text(`Generated ${when} UTC   |   Dockhand ${report.appVersion}   |   ${scope}`,
			textLeft, MARGIN + 21, { lineBreak: false });

	doc.moveTo(left, MARGIN + 44).lineTo(right, MARGIN + 44).lineWidth(0.5).strokeColor(RULE).stroke();
	doc.y = MARGIN + 60;
}

function drawFigures(doc: PDFKit.PDFDocument, report: EnvironmentReport, left: number, width: number) {
	const items = headlineFigures(report);
	const cell = width / items.length;
	const top = doc.y;
	items.forEach((item, i) => {
		const x = left + i * cell;
		doc.fillColor(item.color || BRAND_INK).font('Helvetica-Bold').fontSize(19)
			.text(String(item.value), x, top, { width: cell - 8, lineBreak: false });
		doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
			.text(item.label.toUpperCase(), x, top + 23, { width: cell - 8, characterSpacing: 0.6, lineBreak: false });
	});
	doc.y = top + 46;
}

function drawTable<T>(doc: PDFKit.PDFDocument, title: string, columns: Column<T>[], rows: T[], left: number, width: number) {
	if (doc.y > doc.page.height - 150) {
		doc.addPage();
		doc.y = MARGIN;
	}
	doc.fillColor(BRAND_INK).font('Helvetica-Bold').fontSize(10.5).text(title, left, doc.y, { lineBreak: false });
	doc.y += 16;

	const heading = () => {
		const y = doc.y;
		doc.rect(left, y - 2, width, 15).fill(HEAD_BG);
		let x = left + 5;
		for (const col of columns) {
			doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5)
				.text(col.heading.toUpperCase(), x, y + 2.5, { width: col.width - 8, characterSpacing: 0.4, lineBreak: false });
			x += col.width;
		}
		doc.y = y + 17;
	};
	heading();

	if (rows.length === 0) {
		doc.fillColor(DIM).font('Helvetica-Oblique').fontSize(8)
			.text('Nothing to report.', left + 5, doc.y, { lineBreak: false });
		doc.y += ROW_H + 12;
		return;
	}

	rows.forEach((row, i) => {
		if (doc.y > doc.page.height - BOTTOM_GUARD) {
			doc.addPage();
			doc.y = MARGIN;
			heading();
		}
		const y = doc.y;
		if (i % 2) doc.rect(left, y - 2, width, ROW_H).fill(STRIPE);
		let x = left + 5;
		for (const col of columns) {
			doc.fillColor(col.color ? col.color(row) : '#1f2937')
				.font(col.mono ? 'Courier' : 'Helvetica').fontSize(7.5)
				.text(fitToWidth(doc, col.value(row), col.width - 8), x, y, {
					width: col.width - 8,
					lineBreak: false
				});
			x += col.width;
		}
		doc.y = y + ROW_H;
	});
	doc.y += 14;
}

function drawEnvironment(doc: PDFKit.PDFDocument, env: ReportEnvironment, left: number, width: number) {
	const count = env.containers.length;
	const title = env.unreachable
		? `${env.name}  -  unreachable`
		: `${env.name}  -  ${count} ${count === 1 ? 'container' : 'containers'}`;

	if (env.unreachable) {
		if (doc.y > doc.page.height - 120) { doc.addPage(); doc.y = MARGIN; }
		doc.fillColor(BRAND_INK).font('Helvetica-Bold').fontSize(10.5).text(title, left, doc.y, { lineBreak: false });
		doc.y += 14;
		// An environment that could not be read is not an empty one, and a compliance
		// reader has to be able to tell those apart.
		const reason =
			env.unreachableReason || 'The environment could not be read, so its contents are unknown.';
		doc.fillColor(CRITICAL).font('Helvetica').fontSize(8);
		// A daemon error can be several lines long, and `text` advances the cursor past
		// however many it actually took - so the gap is added to where it left off, not
		// to where it started.
		doc.text(reason, left + 5, doc.y, { width: width - 10 });
		doc.y += 8;
		return;
	}

	drawTable<ReportEnvironment['containers'][number]>(doc, title, [
		{ heading: 'Container', width: 150, value: (c) => c.name },
		{ heading: 'Image', width: 190, mono: true, value: (c) => c.image },
		{ heading: 'Status', width: 60, value: (c) => c.status,
			color: (c) => (c.status === 'running' ? RUNNING : DIM) },
		{ heading: 'Stack', width: 99, value: (c) => c.stack || '-' }
	], env.containers, left, width);
}

function drawScans(doc: PDFKit.PDFDocument, report: EnvironmentReport, left: number, width: number) {
	const scans: Array<ReportImageScan & { env: string }> = [];
	for (const env of report.environments) {
		for (const scan of env.scans) scans.push({ ...scan, env: env.name });
	}
	drawTable<(typeof scans)[number]>(doc, 'Vulnerability scans', [
		{ heading: 'Image', width: 180, mono: true, value: (s) => s.image },
		{ heading: 'Environment', width: 78, value: (s) => s.env },
		{ heading: 'Critical', width: 52, value: (s) => String(s.critical),
			color: (s) => (s.critical > 0 ? CRITICAL : DIM) },
		{ heading: 'High', width: 34, value: (s) => String(s.high),
			color: (s) => (s.high > 0 ? HIGH : DIM) },
		{ heading: 'Medium', width: 44, value: (s) => String(s.medium) },
		{ heading: 'Low', width: 30, value: (s) => String(s.low) },
		{ heading: 'Scanned', width: 79, value: (s) => (s.scannedAt || '-').slice(0, 10) }
	], scans, left, width);
}

function drawChanges(doc: PDFKit.PDFDocument, report: EnvironmentReport, left: number, width: number) {
	const changes = report.environments.flatMap((env) => (env.changes || []).map((c) => ({ ...c, env: env.name })));
	drawTable<(typeof changes)[number]>(doc, 'Change history', [
		{ heading: 'When', width: 92, value: (c) => (c.at || '').replace('T', ' ').slice(0, 16) },
		{ heading: 'Environment', width: 78, value: (c) => c.env },
		{ heading: 'User', width: 76, value: (c) => c.username },
		{ heading: 'Action', width: 82, value: (c) => c.action },
		{ heading: 'Target', width: 171, value: (c) => `${c.entityType}: ${c.entityName}` }
	], changes, left, width);
}

function drawFooters(doc: PDFKit.PDFDocument, left: number, width: number) {
	const range = doc.bufferedPageRange();
	const total = range.start + range.count;
	for (let i = range.start; i < total; i++) {
		doc.switchToPage(i);
		const y = doc.page.height - 38;
		doc.moveTo(left, y - 8).lineTo(left + width, y - 8).lineWidth(0.5).strokeColor(RULE).stroke();
		// Writing below the bottom margin appends a page, which would both corrupt the count
		// being printed and leave blank pages behind. Lift the margin for the footer only.
		const bottom = doc.page.margins.bottom;
		doc.page.margins.bottom = 0;
		doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
			.text('Dockhand environment state report', left, y, { width: width / 2, lineBreak: false });
		doc.text(`Page ${i + 1} of ${total}`, left + width / 2, y, { width: width / 2, align: 'right', lineBreak: false });
		doc.page.margins.bottom = bottom;
	}
	doc.flushPages();
}
