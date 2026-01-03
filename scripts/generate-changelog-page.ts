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

interface ChangelogEntry {
	version: string;
	date: string;
	changes: Array<{ type: 'feature' | 'fix'; text: string }>;
	imageTag: string;
}

// SVG icons for change types
const FEATURE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>`;

const FIX_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="8" height="14" x="8" y="6" rx="4"/><path d="m19 7-3 2"/><path d="m5 7 3 2"/><path d="m19 19-3-2"/><path d="m5 19 3-2"/><path d="M20 13h-4"/><path d="M4 13h4"/><path d="m10 4 1 2"/><path d="m14 4-1 2"/></svg>`;

const TOGGLE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>`;

const COPY_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;

function formatDate(dateStr: string): string {
	const date = new Date(dateStr);
	return date.toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	});
}

function generateChangeItem(change: { type: 'feature' | 'fix'; text: string }): string {
	const pillClass = change.type === 'feature' ? 'changelog-pill-feature' : 'changelog-pill-fix';
	const svg = change.type === 'feature' ? FEATURE_SVG : FIX_SVG;
	const label = change.type === 'feature' ? 'New' : 'Fix';
	return `                            <li><span class="changelog-pill ${pillClass}">${svg}${label}</span>${change.text}</li>`;
}

function generateLatestEntry(entry: ChangelogEntry): string {
	const changes = entry.changes.map(generateChangeItem).join('\n');
	const version = entry.version.startsWith('v') ? entry.version : `v${entry.version}`;

	return `                <!-- ${version} -->
                <div class="changelog-entry">
                    <div class="changelog-header">
                        <div class="changelog-version">
                            <h3>${version}</h3>
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
	const changes = entry.changes.map(generateChangeItem).join('\n');
	const version = entry.version.startsWith('v') ? entry.version : `v${entry.version}`;

	return `                <!-- ${version} (collapsible) -->
                <div class="changelog-entry collapsible" data-version="${version}">
                    <div class="changelog-header">
                        <div class="changelog-version">
                            <h3>${version}</h3>
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

function generateChangelogSection(entries: ChangelogEntry[]): string {
	if (entries.length === 0) {
		return '';
	}

	const [latest, ...rest] = entries;
	const latestHtml = generateLatestEntry(latest);
	const restHtml = rest.map(generateCollapsibleEntry).join('\n');

	return `    <!-- Changelog Section -->
    <section class="changelog" id="changelog">
        <div class="changelog-container">
            <div class="section-header">
                <div class="section-label">Changelog</div>
                <h2 class="section-title">Release history</h2>
                <p class="section-subtitle">Track our progress and see what's new in each version. <span style="color: #fbbf24; white-space: nowrap;">Spoiler: it gets better every time.</span></p>
            </div>
            <div class="changelog-list">
${latestHtml}
${restHtml}
            </div>
        </div>
    </section>`;
}

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
console.log('');
console.log('Generated changelog in webpage/index.html');
console.log(`  - Latest version: v${changelog[0]?.version || 'unknown'}`);
console.log(`  - Total entries: ${changelog.length}`);
