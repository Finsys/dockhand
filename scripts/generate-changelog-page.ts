#!/usr/bin/env bun
/**
 * Generate changelog section in webpage/index.html from src/lib/data/changelog.json
 * This ensures a single source of truth for release information
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const ROOT_DIR = join(import.meta.dir, '..');
const CHANGELOG_PATH = join(ROOT_DIR, 'src/lib/data/changelog.json');
const INDEX_PATH = join(ROOT_DIR, 'webpage/index.html');
const RSS_PATH = join(ROOT_DIR, 'webpage/changelog.xml');
const CHANGELOG_PAGE_PATH = join(ROOT_DIR, 'webpage/changelog.html');
const SITEMAP_PATH = join(ROOT_DIR, 'webpage/sitemap.xml');
const SITE_URL = 'https://dockhand.pro';

interface ChangelogEntry {
	version: string;
	date: string;
	changes: Array<{ type: 'feature' | 'fix'; text: string }>;
	imageTag: string;
	comingSoon?: boolean;
}

// Each icon is defined once per page (iconSprite) and referenced with <use>, so a long
// changelog does not repeat the path data for every entry.
const ICON_PATHS: Record<string, string> = {
	feature: `<path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>`,
	fix: `<rect width="8" height="14" x="8" y="6" rx="4"/><path d="m19 7-3 2"/><path d="m5 7 3 2"/><path d="m19 19-3-2"/><path d="m5 19 3-2"/><path d="M20 13h-4"/><path d="M4 13h4"/><path d="m10 4 1 2"/><path d="m14 4-1 2"/>`,
	toggle: `<polyline points="6 9 12 15 18 9"/>`,
	rss: `<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>`,
	copy: `<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`,
	github: `<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>`,
	// Lucide git-pull-request-arrow, so PR refs are visually distinct from issues.
	pr: `<circle cx="5" cy="6" r="3"/><path d="M5 9v12"/><path d="m15 9-3-3 3-3"/><path d="M12 6h5a3 3 0 0 1 3 3v10"/>`,
	archive: `<path d="m21 8-2 2-1.5-3.7A2 2 0 0 0 15.64 5H8.36a2 2 0 0 0-1.86 1.3L5 10l-2-2"/><path d="M3.1 11.2A2 2 0 0 0 3 12v6c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-.1-.8"/><path d="M10 14h4"/>`
};

const STROKE = 'fill="none" stroke="currentColor" stroke-width="2"';

function icon(id: keyof typeof ICON_PATHS, attrs: string): string {
	return `<svg viewBox="0 0 24 24" ${attrs}><use href="#i-${id}"/></svg>`;
}

/** The symbols every icon() refers to; emitted once at the top of the changelog section. */
export function iconSprite(): string {
	const symbols = Object.entries(ICON_PATHS)
		.map(([id, paths]) => `<symbol id="i-${id}" viewBox="0 0 24 24">${paths}</symbol>`)
		.join('');
	return `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${symbols}</defs></svg>`;
}

const FEATURE_SVG = icon('feature', STROKE);
const FIX_SVG = icon('fix', STROKE);
const TOGGLE_SVG = icon('toggle', STROKE);
const RSS_SVG = icon('rss', `${STROKE} stroke-linecap="round" stroke-linejoin="round"`);
const COPY_SVG = icon('copy', STROKE);
const GITHUB_SVG = icon('github', 'fill="currentColor" style="width:10px;height:10px"');
const PR_SVG = icon('pr', `${STROKE} stroke-linecap="round" stroke-linejoin="round" style="width:10px;height:10px;vertical-align:-1px;margin-right:1px"`);
const ARCHIVE_SVG = icon('archive', STROKE);

function formatDate(dateStr: string, comingSoon?: boolean): string {
	if (!dateStr || comingSoon) {
		return 'Coming soon';
	}
	const date = new Date(dateStr);
	if (isNaN(date.getTime())) {
		return 'Coming soon';
	}
	return date.toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	});
}

function sortChanges(changes: Array<{ type: 'feature' | 'fix'; text: string }>): Array<{ type: 'feature' | 'fix'; text: string }> {
	return [...changes].sort((a, b) => {
		if (a.type === b.type) return 0;
		return a.type === 'feature' ? -1 : 1;
	});
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function linkifyIssues(text: string): string {
	// Tokenize PR#N, #N, and @username. Collect each contiguous group of refs
	// (separated only by whitespace, commas, or parens) into a single pill cluster
	// prefixed by the GitHub octocat icon.
	const PATTERN = /PR#(\d+)|#(\d+)|@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}))/g;

	type RefLink = { html: string };
	const matches: Array<{ start: number; end: number; ref: RefLink }> = [];

	for (const m of text.matchAll(PATTERN)) {
		const start = m.index ?? 0;
		const end = start + m[0].length;
		let html: string;
		if (m[1]) {
			html = `<a href="https://github.com/Finsys/dockhand/pull/${m[1]}" target="_blank" rel="noopener noreferrer" class="changelog-issue-link" title="Pull request #${m[1]}">${PR_SVG}#${m[1]}</a>`;
		} else if (m[2]) {
			html = `<a href="https://github.com/Finsys/dockhand/issues/${m[2]}" target="_blank" rel="noopener noreferrer" class="changelog-issue-link" title="Issue #${m[2]}">#${m[2]}</a>`;
		} else {
			const name = m[3]!;
			html = `<a href="https://github.com/${name}" target="_blank" rel="noopener noreferrer" class="changelog-issue-link" title="@${name} on GitHub">@${name}</a>`;
		}
		matches.push({ start, end, ref: { html } });
	}

	if (matches.length === 0) return escapeHtml(text);

	// Group adjacent matches whose gap contains only [\s,()]
	const GLUE_RE = /^[\s,()]*$/;
	const groups: Array<{ start: number; end: number; refs: RefLink[] }> = [];
	let current = { start: matches[0].start, end: matches[0].end, refs: [matches[0].ref] };
	for (let i = 1; i < matches.length; i++) {
		const gap = text.slice(current.end, matches[i].start);
		if (GLUE_RE.test(gap)) {
			current.refs.push(matches[i].ref);
			current.end = matches[i].end;
		} else {
			groups.push(current);
			current = { start: matches[i].start, end: matches[i].end, refs: [matches[i].ref] };
		}
	}
	groups.push(current);

	// Expand each group's bounds to swallow surrounding glue (parens, commas, spaces)
	// so we don't end up with "foo  · #123" or "foo (#123)" leftovers.
	let out = '';
	let lastIndex = 0;
	for (const g of groups) {
		let s = g.start;
		while (s > lastIndex && /[\s(]/.test(text[s - 1])) s--;
		let e = g.end;
		while (e < text.length && /[\s),]/.test(text[e])) e++;
		out += escapeHtml(text.slice(lastIndex, s));
		out += ` <span class="changelog-issues">${GITHUB_SVG}${g.refs.map(r => r.html).join(' · ')}</span>`;
		lastIndex = e;
	}
	out += escapeHtml(text.slice(lastIndex));

	return out;
}

function generateChangeItem(change: { type: 'feature' | 'fix'; text: string }): string {
	const pillClass = change.type === 'feature' ? 'changelog-pill-feature' : 'changelog-pill-fix';
	const svg = change.type === 'feature' ? FEATURE_SVG : FIX_SVG;
	const label = change.type === 'feature' ? 'New' : 'Fix';
	return `                            <li><span class="changelog-pill ${pillClass}">${svg}${label}</span><span class="changelog-text">${linkifyIssues(change.text)}</span></li>`;
}

function versionLink(version: string, comingSoon?: boolean): string {
	if (comingSoon) return version;
	return `<a href="https://github.com/Finsys/dockhand/releases/tag/${version}" target="_blank" rel="noopener noreferrer" class="changelog-version-link">${version} ${GITHUB_SVG}</a>`;
}

function generateComingSoonEntry(entry: ChangelogEntry): string {
	const changes = sortChanges(entry.changes).map(generateChangeItem).join('\n');
	const version = entry.version.startsWith('v') ? entry.version : `v${entry.version}`;

	return `                <!-- ${version} (coming soon) -->
                <div class="changelog-entry" id="${version}">
                    <div class="changelog-header">
                        <div class="changelog-version">
                            <h3>${versionLink(version, true)}</h3>
                            <span class="changelog-badge" style="background: linear-gradient(135deg, #f59e0b, #d97706); animation: pulseGlowAmber 2s ease-in-out infinite;">Coming soon</span>
                        </div>
                        <span class="changelog-date">${formatDate(entry.date, true)}</span>
                    </div>
                    <ul class="changelog-changes">
${changes}
                    </ul>
                </div>`;
}

function generateLatestEntry(entry: ChangelogEntry): string {
	const changes = sortChanges(entry.changes).map(generateChangeItem).join('\n');
	const version = entry.version.startsWith('v') ? entry.version : `v${entry.version}`;

	return `                <!-- ${version} -->
                <div class="changelog-entry" id="${version}">
                    <div class="changelog-header">
                        <div class="changelog-version">
                            <h3>${versionLink(version)}</h3>
                            <span class="changelog-badge">Latest</span>
                        </div>
                        <span class="changelog-date">${formatDate(entry.date)}</span>
                    </div>
                    <ul class="changelog-changes">
${changes}
                    </ul>
                    <div class="changelog-image-tag">
                        <span>Docker image:</span>
                        <code>${entry.imageTag}</code>
                        <button class="copy-btn" onclick="copyDockerImage(this, '${entry.imageTag}')" title="Copy to clipboard">${COPY_SVG}</button>
                        <span style="color: var(--text-muted); margin: 0 0.25rem;">or</span>
                        <code>fnsys/dockhand:latest</code>
                        <button class="copy-btn" onclick="copyDockerImage(this, 'fnsys/dockhand:latest')" title="Copy to clipboard">${COPY_SVG}</button>
                    </div>
                </div>`;
}

function generateCollapsibleEntry(entry: ChangelogEntry): string {
	const changes = sortChanges(entry.changes).map(generateChangeItem).join('\n');
	const version = entry.version.startsWith('v') ? entry.version : `v${entry.version}`;

	return `                <!-- ${version} (collapsible) -->
                <div class="changelog-entry collapsible" id="${version}" data-version="${version}">
                    <div class="changelog-header">
                        <div class="changelog-version">
                            <h3>${versionLink(version)}</h3>
                            <span class="changelog-toggle">${TOGGLE_SVG}</span>
                        </div>
                        <span class="changelog-date">${formatDate(entry.date)}</span>
                    </div>
                    <div class="changelog-content">
                        <ul class="changelog-changes">
${changes}
                        </ul>
                        <div class="changelog-image-tag">
                            <span>Docker image:</span>
                            <code>${entry.imageTag}</code>
                            <button class="copy-btn" onclick="copyDockerImage(this, '${entry.imageTag}')" title="Copy to clipboard">${COPY_SVG}</button>
                        </div>
                    </div>
                </div>`;
}

function generateRecentEntry(entry: ChangelogEntry): string {
	const changes = sortChanges(entry.changes).map(generateChangeItem).join('\n');
	const version = entry.version.startsWith('v') ? entry.version : `v${entry.version}`;

	return `                <!-- ${version} -->
                <div class="changelog-entry" id="${version}">
                    <div class="changelog-header">
                        <div class="changelog-version">
                            <h3>${versionLink(version)}</h3>
                        </div>
                        <span class="changelog-date">${formatDate(entry.date)}</span>
                    </div>
                    <ul class="changelog-changes">
${changes}
                    </ul>
                    <div class="changelog-image-tag">
                        <span>Docker image:</span>
                        <code>${entry.imageTag}</code>
                        <button class="copy-btn" onclick="copyDockerImage(this, '${entry.imageTag}')" title="Copy to clipboard">${COPY_SVG}</button>
                    </div>
                </div>`;
}


/**
 * The changelog section. The homepage (`full: false`) shows what is coming and the latest
 * releases, then links to changelog.html; the full page also lists every older release.
 */
export function generateChangelogSection(entries: ChangelogEntry[], full = true): string {
	if (entries.length === 0) {
		return '';
	}

	// Separate coming soon entries from released entries
	const comingSoonEntries = entries.filter(e => e.comingSoon);
	const releasedEntries = entries.filter(e => !e.comingSoon);

	// Latest 3 released versions shown expanded
	const RECENT_COUNT = 3;
	const latestReleased = releasedEntries[0];
	const recentEntries = releasedEntries.slice(1, RECENT_COUNT);
	const olderEntries = releasedEntries.slice(RECENT_COUNT);

	// Generate HTML for each section
	const comingSoonHtml = comingSoonEntries.map(generateComingSoonEntry).join('\n');
	const latestHtml = latestReleased ? generateLatestEntry(latestReleased) : '';
	const recentHtml = recentEntries.map(generateRecentEntry).join('\n');
	const olderHtml = olderEntries.map(generateCollapsibleEntry).join('\n');

	// Build older releases wrapper if there are older entries
	let olderSection = '';
	if (olderEntries.length > 0 && !full) {
		olderSection = `
                <a class="older-releases-wrapper older-releases-link" href="/changelog.html">
                    <div class="older-releases-header">
                        <h4>${ARCHIVE_SVG}Full release history (${releasedEntries.length} releases)</h4>
                    </div>
                </a>`;
	} else if (olderEntries.length > 0) {
		const firstOlder = olderEntries[0].version.startsWith('v') ? olderEntries[0].version : `v${olderEntries[0].version}`;
		const lastOlder = olderEntries[olderEntries.length - 1].version.startsWith('v') ? olderEntries[olderEntries.length - 1].version : `v${olderEntries[olderEntries.length - 1].version}`;
		olderSection = `
                <!-- Older Releases -->
                <div class="older-releases-wrapper" id="older-releases">
                    <div class="older-releases-header" onclick="toggleOlderReleases()">
                        <h4>${ARCHIVE_SVG}Older releases (${firstOlder} – ${lastOlder})</h4>
                        <svg class="older-releases-toggle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                    </div>
                    <div class="older-releases-content">
${olderHtml}
                    </div>
                </div>`;
	}

	return `    <!-- Changelog Section -->
    <section class="changelog" id="changelog">
        ${iconSprite()}
        <div class="changelog-container">
            <div class="section-header">
                <div class="section-label">Changelog</div>
                <div class="changelog-title-row">
                    <h2 class="section-title">Release history</h2>
                    <a class="changelog-rss-link" href="/changelog.xml" title="Subscribe to release notes (RSS)">${RSS_SVG}<span>RSS</span></a>
                </div>
                <p class="section-subtitle">Track our progress and see what's new in each version. <span style="color: #fbbf24; white-space: nowrap;">Spoiler: it gets better every time.</span></p>
            </div>
            <div class="changelog-list">
${comingSoonHtml}
${latestHtml}
${recentHtml}${olderSection}
            </div>
        </div>
    </section>`;
}

// Strip ref tokens (#N, PR#N, @user) from changelog text for the plain-text RSS feed.
// A trailing "(#1313, PR#1339, @user)" cluster is removed whole; bare refs mid-text too.
export function stripRefs(text: string): string {
	const ref = '(?:PR)?#\\d+|@[\\w-]+';
	return text
		// Whole parenthesised ref cluster: "(#1, PR#2, @u)" -> ""
		.replace(new RegExp(`\\s*\\((?:\\s*(?:${ref})\\s*[,\\s]*)+\\)`, 'g'), '')
		// Any leftover bare refs
		.replace(new RegExp(ref, 'g'), '')
		// Tidy ONLY separators orphaned by a removed ref (e.g. "a , , b" -> "a b"),
		// not legitimate prose punctuation like "(./config, ./data)".
		.replace(/\s+,(\s|$)/g, '$1')
		.replace(/\s{2,}/g, ' ')
		.replace(/[,;]\s*$/g, '')
		.trim();
}

// The version the site advertises as current. A coming-soon entry is not downloadable,
// so it is never the answer; null means nothing has shipped yet.
export function latestReleasedVersion(entries: ChangelogEntry[]): string | null {
	return entries.find((e) => !e.comingSoon)?.version ?? null;
}

// Build an RSS 2.0 feed from the released changelog entries (coming-soon excluded).
export function generateRssFeed(entries: ChangelogEntry[]): string {
	const released = entries.filter((e) => !e.comingSoon && e.date);
	const items = released
		.map((e) => {
			const ver = e.version.startsWith('v') ? e.version : `v${e.version}`;
			const pubDate = new Date(`${e.date}T00:00:00Z`).toUTCString();
			const body = e.changes
				.map((c) => `${c.type === 'feature' ? 'Feature' : 'Fix'}: ${stripRefs(c.text)}`)
				.join('\n');
			return `        <item>
            <title>Dockhand ${escapeHtml(ver)}</title>
            <link>${SITE_URL}/changelog.html#${escapeHtml(ver)}</link>
            <guid isPermaLink="false">dockhand-${escapeHtml(ver)}</guid>
            <pubDate>${pubDate}</pubDate>
            <description>${escapeHtml(body)}</description>
        </item>`;
		})
		.join('\n');
	const lastBuild = released[0]?.date
		? new Date(`${released[0].date}T00:00:00Z`).toUTCString()
		: new Date().toUTCString();
	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
    <channel>
        <title>Dockhand - Release notes</title>
        <link>${SITE_URL}/changelog.html</link>
        <atom:link href="${SITE_URL}/changelog.xml" rel="self" type="application/rss+xml"/>
        <description>New features and fixes in each Dockhand release.</description>
        <language>en</language>
        <lastBuildDate>${lastBuild}</lastBuildDate>
${items}
    </channel>
</rss>
`;
}

// The <head> and chrome of the full changelog page come from index.html, so the two pages
// share one stylesheet, nav and footer; in-page anchors are pointed back at the homepage.
export function generateChangelogPage(indexHtml: string, entries: ChangelogEntry[]): string {
	const style = indexHtml.match(/    <style>[\s\S]*?<\/style>/)?.[0];
	const nav = indexHtml.match(/    <nav>[\s\S]*?<\/nav>/)?.[0];
	const footer = indexHtml.match(/    <footer>[\s\S]*?<\/footer>/)?.[0];
	if (!style || !nav || !footer) throw new Error('index.html is missing its <style>, <nav> or <footer>');
	const toHome = (html: string) =>
		html
			.replace(/href="#"/g, 'href="/"')
			.replace(/href="#([a-z-]+)"/g, 'href="/#$1"')
			.replace(/href="manual\//g, 'href="/manual/')
			.replace(/\s*<li><a href="\/" class="open-roadmap-modal">Roadmap<\/a><\/li>/, '');
	const released = entries.filter((e) => !e.comingSoon);
	const latest = released[0];
	const title = 'Dockhand release history - every version and change';
	const description = `New features and fixes in every Dockhand release${latest ? `, up to v${latest.version.replace(/^v/, '')}` : ''}.`;
	return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <meta name="description" content="${description}">
    <meta name="robots" content="index, follow">
    <link rel="canonical" href="${SITE_URL}/changelog.html">
    <link rel="alternate" type="application/rss+xml" title="Dockhand - Release notes" href="${SITE_URL}/changelog.xml">
    <meta property="og:type" content="website">
    <meta property="og:url" content="${SITE_URL}/changelog.html">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:image" content="${SITE_URL}/images/og-image.jpg">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="Dockhand dashboard with Docker environments, containers and resource usage">
    <meta property="og:site_name" content="Dockhand">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:image" content="${SITE_URL}/images/og-image.jpg">
    <meta name="theme-color" content="#0a0f14">
    <link rel="icon" href="/favicon.ico" sizes="48x48">
    <link rel="icon" type="image/svg+xml" href="/images/favicon.svg">
    <link rel="apple-touch-icon" href="/images/apple-touch-icon.png">
    <link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin>
${style}
</head>
<body>
${toHome(nav)}

    <main>
${generateChangelogSection(entries, true)}
    </main>

${toHome(footer)}

    <script>
        document.querySelectorAll('.changelog-entry.collapsible').forEach((entry) => {
            entry.querySelector('.changelog-header').addEventListener('click', () => entry.classList.toggle('expanded'));
        });
        function toggleOlderReleases() {
            document.getElementById('older-releases')?.classList.toggle('expanded');
        }
        function copyDockerImage(btn, text) {
            navigator.clipboard.writeText(text);
            const svg = btn.querySelector('svg');
            const original = svg.innerHTML;
            svg.innerHTML = '<path d="M20 6L9 17l-5-5" stroke-linecap="round" stroke-linejoin="round"/>';
            btn.style.color = '#22c55e';
            setTimeout(() => {
                svg.innerHTML = original;
                btn.style.color = '';
            }, 1500);
        }
        // A deep link to an older release opens it.
        const target = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
        if (target) {
            target.closest('.older-releases-wrapper')?.classList.add('expanded');
            if (target.classList.contains('collapsible')) target.classList.add('expanded');
            target.scrollIntoView();
        }
        (function () {
            const nav = document.querySelector('nav');
            const toggle = document.querySelector('.nav-toggle');
            const menu = document.querySelector('.nav-menu');
            if (!nav || !toggle || !menu) return;
            const setOpen = (open) => {
                nav.classList.toggle('open', open);
                menu.classList.toggle('open', open);
                toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            };
            toggle.addEventListener('click', () => setOpen(!nav.classList.contains('open')));
            menu.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => setOpen(false)));
        })();
    </script>
</body>
</html>
`;
}

// The sitemap, with the homepage and changelog dated by the latest release.
export function generateSitemap(entries: ChangelogEntry[]): string {
	const lastmod = entries.find((e) => !e.comingSoon && e.date)?.date;
	const url = (path: string, changefreq: string, priority: string, dated: boolean) => `  <url>
    <loc>${SITE_URL}${path}</loc>${dated && lastmod ? `
    <lastmod>${lastmod}</lastmod>` : ''}
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${url('/', 'weekly', '1.0', true)}
${url('/changelog.html', 'weekly', '0.7', true)}
${url('/manual/', 'weekly', '0.8', false)}
${url('/license.html', 'yearly', '0.3', false)}
${url('/privacy.html', 'yearly', '0.3', false)}
</urlset>
`;
}

// Guarded so the pure functions above (e.g. stripRefs) can be imported by unit tests
// without triggering file reads/writes.
if (import.meta.main) {
	// Read changelog.json
	console.log('Reading changelog from:', CHANGELOG_PATH);
	const changelog: ChangelogEntry[] = JSON.parse(readFileSync(CHANGELOG_PATH, 'utf-8'));
	console.log(`Found ${changelog.length} changelog entries`);

	// Read index.html
	console.log('Reading index.html from:', INDEX_PATH);
	let indexHtml = readFileSync(INDEX_PATH, 'utf-8');

	// Generate new changelog section
	const newChangelogSection = generateChangelogSection(changelog, false);

	// Replace changelog section using regex
	// Match from "<!-- Changelog Section -->" to the closing "</section>" before "<!-- CTA -->"
	const changelogRegex = /    <!-- Changelog Section -->[\s\S]*?<\/section>(?=\s*\n\s*<!-- CTA -->)/;

	if (!changelogRegex.test(indexHtml)) {
		console.error('ERROR: Could not find changelog section in index.html');
		console.error('Looking for pattern: <!-- Changelog Section --> ... </section> followed by <!-- CTA -->');
		process.exit(1);
	}

	indexHtml = indexHtml.replace(changelogRegex, newChangelogSection);

	// Also update softwareVersion in JSON-LD schema.
	const latestVersion = latestReleasedVersion(changelog);
	if (latestVersion) {
		// Match "softwareVersion": "X.X" or "softwareVersion": "X.X.X"
		const versionRegex = /"softwareVersion":\s*"[\d.]+"/;
		if (versionRegex.test(indexHtml)) {
			indexHtml = indexHtml.replace(versionRegex, `"softwareVersion": "${latestVersion}"`);
			console.log(`Updated softwareVersion to: ${latestVersion}`);
		}
	}

	// Write back to index.html
	writeFileSync(INDEX_PATH, indexHtml);

	// The full history page, the RSS feed and the sitemap alongside the homepage
	writeFileSync(CHANGELOG_PAGE_PATH, generateChangelogPage(indexHtml, changelog));
	writeFileSync(RSS_PATH, generateRssFeed(changelog));
	writeFileSync(SITEMAP_PATH, generateSitemap(changelog));
	console.log('Generated RSS feed in webpage/changelog.xml');

	console.log('');
	console.log('Generated changelog in webpage/index.html');
	console.log(`  - Latest version: v${changelog[0]?.version || 'unknown'}`);
	console.log(`  - Total entries: ${changelog.length}`);
}
