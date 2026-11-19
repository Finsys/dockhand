/**
 * The website changelog: the homepage shows the latest releases and links to the full
 * history page, icons are shared through one sprite, and the sitemap is dated by the
 * latest release.
 */
import { describe, test, expect } from 'bun:test';
import {
	generateChangelogSection,
	generateChangelogPage,
	generateSitemap,
	generateRssFeed,
	iconSprite
} from '../scripts/generate-changelog-page';

/** Every <use> must name a symbol the sprite defines, or the icon renders empty. */
function expectIconsResolve(html: string) {
	const defined = new Set([...iconSprite().matchAll(/<symbol id="i-([a-z]+)"/g)].map((m) => m[1]));
	const used = [...html.matchAll(/<use href="#i-([a-z]+)"\/>/g)].map((m) => m[1]);
	expect(used.length).toBeGreaterThan(0);
	for (const id of used) expect(defined.has(id)).toBe(true);
	return new Set(used);
}

const entry = (version: string, date: string, comingSoon = false) => ({
	version,
	date,
	comingSoon,
	imageTag: `fnsys/dockhand:v${version}`,
	changes: [
		{ type: 'feature' as const, text: `feature in ${version} (#1, PR#2, @someone)` },
		{ type: 'fix' as const, text: `fix in ${version}` }
	]
});

const entries = [
	entry('1.0.9', '2026-12-01', true),
	...Array.from({ length: 8 }, (_, i) => entry(`1.0.${8 - i}`, `2026-0${9 - i}-01`))
];

const INDEX = `<html><head>
    <style>
        body { color: red; }
    </style>
</head><body>
    <nav>
        <a href="#" class="logo">Dockhand</a>
        <ul>
                    <li><a href="#features">Features</a></li>
                    <li><a href="#" class="open-roadmap-modal">Roadmap</a></li>
                    <li><a href="manual/" target="_blank">Docs</a></li>
        </ul>
    </nav>
    <footer>
        <a href="#pricing">Pricing</a>
    </footer>
</body></html>`;

describe('homepage changelog section', () => {
	const html = generateChangelogSection(entries, false);

	test('shows what is coming and the latest three releases, and links to the full page', () => {
		for (const v of ['v1.0.9', 'v1.0.8', 'v1.0.7', 'v1.0.6']) expect(html).toContain(`id="${v}"`);
		for (const v of ['v1.0.5', 'v1.0.1']) expect(html).not.toContain(`id="${v}"`);
		expect(html).toContain('href="/changelog.html"');
		expect(html).toContain('Full release history (8 releases)');
	});

	test('icons are referenced from the sprite, never inlined per entry', () => {
		expect(html.split(iconSprite()).length).toBe(2);
		expect(html).toContain('<use href="#i-github"/>');
		// The github path data appears once (in the sprite) however many refs there are.
		expect(html.split('M12 0c-6.626').length).toBe(2);
		const used = expectIconsResolve(html);
		for (const id of ['feature', 'fix', 'github', 'pr', 'copy', 'rss', 'archive']) expect(used.has(id)).toBe(true);
	});
});

describe('full changelog page', () => {
	const page = generateChangelogPage(INDEX, entries);

	test('lists every release with a linkable id', () => {
		for (let i = 1; i <= 8; i++) expect(page).toContain(`id="v1.0.${i}"`);
		expect(page).not.toContain('href="/changelog.html"');
		expect(expectIconsResolve(page).has('toggle')).toBe(true);
	});

	test('reuses the homepage styles and chrome, pointing anchors back at the homepage', () => {
		expect(page).toContain('body { color: red; }');
		expect(page).toContain('href="/#features"');
		expect(page).toContain('href="/#pricing"');
		expect(page).toContain('href="/" class="logo"');
		expect(page).toContain('href="/manual/"');
		expect(page).not.toContain('open-roadmap-modal');
		expect(page).toContain('<link rel="canonical" href="https://dockhand.pro/changelog.html">');
	});

	test('names the latest released version, not the coming one', () => {
		expect(page).toContain('up to v1.0.8.');
	});

	test('an index without its chrome is refused', () => {
		expect(() => generateChangelogPage('<html></html>', entries)).toThrow();
	});
});

describe('sitemap', () => {
	test('dates the homepage and changelog by the latest release, not a planned one', () => {
		const xml = generateSitemap(entries);
		expect(xml.match(/<lastmod>2026-09-01<\/lastmod>/g)?.length).toBe(2);
		expect(xml).not.toContain('<lastmod></lastmod>');
		for (const path of ['/', '/changelog.html', '/manual/', '/license.html', '/privacy.html']) {
			expect(xml).toContain(`<loc>https://dockhand.pro${path}</loc>`);
		}
	});
});

describe('RSS feed', () => {
	test('each released version links to its anchor on the full page', () => {
		const xml = generateRssFeed(entries);
		const page = generateChangelogPage(INDEX, entries);
		const links = [...xml.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>/g)].map((m) => m[1]);
		expect(links.length).toBe(8);
		for (const link of links) {
			const anchor = link.match(/^https:\/\/dockhand\.pro\/changelog\.html#(v[\d.]+)$/)?.[1];
			expect(anchor).toBeDefined();
			expect(page).toContain(`id="${anchor}"`);
		}
		expect(xml).not.toContain('v1.0.9');
	});
});
