// Per-line log model shared by LogsPanel and the /logs page. The buffer is an
// array of these — the toggle/search/filter UI is a pure derivation of the
// array, no string concatenation. Avoids regex passes over the whole buffer
// every render and lets Svelte's keyed {#each} diff append-only updates cheaply.

import { AnsiUp } from 'ansi_up';

export interface LogEntry {
	id: number;
	timestamp?: string;
	text: string;
	// Optional fields for grouped/multi-container views
	containerId?: string;
	containerName?: string;
	color?: string;
	stream?: string;
}

const ansiUp = new AnsiUp();
ansiUp.use_classes = true;

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/;

export function parseDockerLine(raw: string): { timestamp?: string; text: string } {
	const m = raw.match(TS_RE);
	if (m) return { timestamp: m[1], text: raw.slice(m[0].length) };
	return { text: raw };
}

let nextId = 0;
export function nextLogId(): number {
	return nextId++;
}

// Split a chunk of raw log text into LogEntry items. The last item may be
// partial (no trailing newline), so it's returned as carryover for the next
// chunk to prepend.
export function parseLines(
	raw: string,
	carryover: string,
	extra: Partial<LogEntry> = {}
): { entries: LogEntry[]; carryover: string } {
	const combined = carryover + raw;
	const lines = combined.split('\n');
	const tail = lines.pop() ?? '';
	const entries: LogEntry[] = [];
	for (const line of lines) {
		if (line === '') continue;
		const { timestamp, text } = parseDockerLine(line);
		entries.push({ id: nextId++, timestamp, text, ...extra });
	}
	return { entries, carryover: tail };
}

// Merge grouped-mode entries into one timeline ordered by Docker's ISO
// timestamp (oldest first, so the newest lands at the bottom). Used for the
// initial tail + stopped-container backfill, NOT for live appends (live lines
// already arrive in order and appending keeps them at the bottom).
//
// A continuation line (multi-line log, no timestamp of its own) must stay glued
// to its parent line from the SAME container, so it inherits the last seen
// timestamp for that container before sorting. ISO timestamps sort correctly as
// strings; ties (or missing timestamps) fall back to `id`, which is monotonic
// with arrival order, giving a stable, deterministic result on every click.
export function sortByTimestampStable(entries: LogEntry[]): LogEntry[] {
	const lastTsByContainer = new Map<string, string>();
	const keyed = entries.map((e) => {
		const cid = e.containerId ?? '';
		let ts = e.timestamp;
		if (ts) {
			lastTsByContainer.set(cid, ts);
		} else {
			ts = lastTsByContainer.get(cid);
		}
		return { e, sortTs: ts ?? '' };
	});
	keyed.sort((a, b) => {
		if (a.sortTs !== b.sortTs) return a.sortTs < b.sortTs ? -1 : 1;
		return a.e.id - b.e.id;
	});
	return keyed.map((k) => k.e);
}

// Per-entry ANSI HTML cache. WeakMap so entries evicted by buffer compaction
// can be GC'd along with their cached HTML.
const ansiCache = new WeakMap<LogEntry, string>();
export function entryHtml(e: LogEntry): string {
	const cached = ansiCache.get(e);
	if (cached !== undefined) return cached;
	const html = ansiUp.ansi_to_html(e.text);
	ansiCache.set(e, html);
	return html;
}

// Render the ANSI HTML for an entry and splice <mark> spans for a search match.
// Splits by HTML tags so substitution doesn't run inside attribute values.
export function renderLineHtml(e: LogEntry, query: string): string {
	const ansi = entryHtml(e);
	if (!query) return ansi;
	const escapedForRegex = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const regex = new RegExp(`(${escapedForRegex})`, 'gi');
	const parts = ansi.split(/(<[^>]*>)/);
	return parts
		.map(part => (part.startsWith('<') ? part : part.replace(regex, '<mark class="search-match">$1</mark>')))
		.join('');
}
