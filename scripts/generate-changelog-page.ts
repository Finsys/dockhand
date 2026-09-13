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
const SITE_URL = 'https://dockhand.pro';

interface ChangelogEntry {
	version: string;
	date: string;
	changes: Array<{ type: 'feature' | 'fix'; text: string }>;
	imageTag: string;
	comingSoon?: boolean;
}

// SVG icons for change types
const FEATURE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>`;

const FIX_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="8" height="14" x="8" y="6" rx="4"/><path d="m19 7-3 2"/><path d="m5 7 3 2"/><path d="m19 19-3-2"/><path d="m5 19 3-2"/><path d="M20 13h-4"/><path d="M4 13h4"/><path d="m10 4 1 2"/><path d="m14 4-1 2"/></svg>`;

const TOGGLE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>`;

// Lucide rss icon for the "subscribe to release notes" link.
const RSS_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>`;

const COPY_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;

const GITHUB_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" style="width:10px;height:10px"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>`;

const EXTLINK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px;vertical-align:middle"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;

// Lucide git-pull-request-arrow — inline before PR refs so they're visually distinct from issues.
const PR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:10px;height:10px;vertical-align:-1px;margin-right:1px"><circle cx="5" cy="6" r="3"/><path d="M5 9v12"/><path d="m15 9-3-3 3-3"/><path d="M12 6h5a3 3 0 0 1 3 3v10"/></svg>`;

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
                <div class="changelog-entry">
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
                <div class="changelog-entry">
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
                <div class="changelog-entry collapsible" data-version="${version}">
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
                <div class="changelog-entry">
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

const ARCHIVE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21 8-2 2-1.5-3.7A2 2 0 0 0 15.64 5H8.36a2 2 0 0 0-1.86 1.3L5 10l-2-2"/><path d="M3.1 11.2A2 2 0 0 0 3 12v6c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-.1-.8"/><path d="M10 14h4"/></svg>`;

function generateChangelogSection(entries: ChangelogEntry[]): string {
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
	if (olderEntries.length > 0) {
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

// Build an RSS 2.0 feed from the released changelog entries (coming-soon excluded).
function generateRssFeed(entries: ChangelogEntry[]): string {
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
            <link>${SITE_URL}/#changelog</link>
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
        <link>${SITE_URL}/#changelog</link>
        <atom:link href="${SITE_URL}/changelog.xml" rel="self" type="application/rss+xml"/>
        <description>New features and fixes in each Dockhand release.</description>
        <language>en</language>
        <lastBuildDate>${lastBuild}</lastBuildDate>
${items}
    </channel>
</rss>
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
	const newChangelogSection = generateChangelogSection(changelog);

	// Replace changelog section using regex
	// Match from "<!-- Changelog Section -->" to the closing "</section>" before "<!-- CTA -->"
	const changelogRegex = /    <!-- Changelog Section -->[\s\S]*?<\/section>(?=\s*\n\s*<!-- CTA -->)/;

	if (!changelogRegex.test(indexHtml)) {
		console.error('ERROR: Could not find changelog section in index.html');
		console.error('Looking for pattern: <!-- Changelog Section --> ... </section> followed by <!-- CTA -->');
		process.exit(1);
	}

	indexHtml = indexHtml.replace(changelogRegex, newChangelogSection);

	// Also update softwareVersion in JSON-LD schema
	if (changelog.length > 0) {
		const latestVersion = changelog[0].version;
		// Match "softwareVersion": "X.X" or "softwareVersion": "X.X.X"
		const versionRegex = /"softwareVersion":\s*"[\d.]+"/;
		if (versionRegex.test(indexHtml)) {
			indexHtml = indexHtml.replace(versionRegex, `"softwareVersion": "${latestVersion}"`);
			console.log(`Updated softwareVersion to: ${latestVersion}`);
		}
	}

	// Write back to index.html
	writeFileSync(INDEX_PATH, indexHtml);

	// Generate the RSS feed alongside the page
	writeFileSync(RSS_PATH, generateRssFeed(changelog));
	console.log('Generated RSS feed in webpage/changelog.xml');

	console.log('');
	console.log('Generated changelog in webpage/index.html');
	console.log(`  - Latest version: v${changelog[0]?.version || 'unknown'}`);
	console.log(`  - Total entries: ${changelog.length}`);
}
