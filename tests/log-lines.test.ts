import { describe, expect, test } from 'bun:test';
import { wrapHtmlLines, stripLogMarkers, GIT_LINE_MARKER } from '../src/lib/utils/log-lines';

describe('wrapHtmlLines', () => {
	test('wraps each line in a log-line div', () => {
		const out = wrapHtmlLines('a\nb');
		expect(out).toBe('<div class="log-line">a</div><div class="log-line">b</div>');
	});

	test('renders an empty line as a non-collapsing space', () => {
		expect(wrapHtmlLines('')).toBe('<div class="log-line"> </div>');
	});

	test('a git-marked line drops the marker and gets the git class + inline svg', () => {
		const out = wrapHtmlLines(`${GIT_LINE_MARKER}Cloning repository...`);
		expect(out).toContain('log-line-git');
		expect(out).toContain('<svg');
		expect(out).toContain('Cloning repository...');
		// The literal marker text must not survive into the output.
		expect(out).not.toContain(GIT_LINE_MARKER);
	});

	test('a plain line is untouched (no git class, no svg)', () => {
		const out = wrapHtmlLines('Container web-1 Started');
		expect(out).not.toContain('log-line-git');
		expect(out).not.toContain('<svg');
	});

	test('stripLogMarkers removes the marker for copy/download', () => {
		const input = `${GIT_LINE_MARKER}Cloning repository...\n Container web-1 Started\n${GIT_LINE_MARKER}Deploying...`;
		expect(stripLogMarkers(input)).toBe('Cloning repository...\n Container web-1 Started\nDeploying...');
	});

	test('stripLogMarkers leaves marker-less text untouched', () => {
		const input = ' Container web-1 Started\nError response from daemon: boom';
		expect(stripLogMarkers(input)).toBe(input);
	});

	test('mixes git and plain lines independently', () => {
		const out = wrapHtmlLines(`${GIT_LINE_MARKER}Fetching\nContainer web-1 Started`);
		const parts = out.split('</div>').filter(Boolean);
		expect(parts[0]).toContain('log-line-git');
		expect(parts[1]).toContain('log-line');
		expect(parts[1]).not.toContain('log-line-git');
	});
});
