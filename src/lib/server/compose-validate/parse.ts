/**
 * Parse a compose file into a plain object plus a key-path -> line resolver.
 *
 * Two parsers on purpose: js-yaml gives the ergonomic plain object the rules read,
 * and eemeli's `yaml` (already in the tree) gives node ranges + a LineCounter for
 * precise editor markers. A duplicate-key or invalid-YAML error surfaces as a
 * parseError with its line (js-yaml is strict about duplicate keys by default).
 */

import jsyaml from 'js-yaml';
import { parseDocument, LineCounter, isNode, isMap, isScalar } from 'yaml';
import type { ParsedCompose } from './types';

export function parseCompose(source: string): ParsedCompose {
	// Plain object for the rules. js-yaml throws on duplicate keys and bad syntax.
	let doc: Record<string, unknown> | null = null;
	let parseError: ParsedCompose['parseError'] | undefined;
	try {
		const loaded = jsyaml.load(source);
		doc = loaded && typeof loaded === 'object' && !Array.isArray(loaded)
			? (loaded as Record<string, unknown>)
			: null;
		if (loaded !== null && loaded !== undefined && doc === null) {
			parseError = { message: 'Compose file must be a YAML mapping at the top level' };
		}
	} catch (e: unknown) {
		const mark = (e as { mark?: { line?: number } })?.mark;
		parseError = {
			message: e instanceof Error ? e.message.split('\n')[0] : 'Invalid YAML',
			line: typeof mark?.line === 'number' ? mark.line + 1 : undefined
		};
	}

	// Position map via eemeli's yaml. Independent of js-yaml so a lint-worthy but
	// js-yaml-rejected file (duplicate key) can still report the error's line above.
	const lineCounter = new LineCounter();
	let positionDoc: ReturnType<typeof parseDocument> | null = null;
	try {
		positionDoc = parseDocument(source, { lineCounter, keepSourceTokens: false });
	} catch {
		positionDoc = null;
	}

	const lineOf = (path: (string | number)[]): number | undefined => {
		if (!positionDoc) return undefined;
		try {
			// For a mapping key (string last segment) return the KEY's line, not its
			// value node: a value that is a nested map/seq starts on the NEXT line, which
			// would push the marker one line down (off-by-one on any parent key).
			const last = path[path.length - 1];
			if (typeof last === 'string') {
				const parent =
					path.length === 1 ? positionDoc.contents : positionDoc.getIn(path.slice(0, -1), true);
				if (isMap(parent)) {
					const pair = parent.items.find((it) => isScalar(it.key) && it.key.value === last);
					if (pair && isNode(pair.key) && pair.key.range) {
						return lineCounter.linePos(pair.key.range[0]).line;
					}
				}
			}
			const node = positionDoc.getIn(path, true);
			if (isNode(node) && node.range) {
				return lineCounter.linePos(node.range[0]).line;
			}
		} catch {
			// bad path -> no line
		}
		return undefined;
	};

	// The 0-based indentation (column - 1) of the KEY at a mapping path, so an
	// insert-fix can match the file's own indentation width. undefined if unresolved.
	const indentOf = (path: (string | number)[]): number | undefined => {
		if (!positionDoc) return undefined;
		try {
			const last = path[path.length - 1];
			if (typeof last !== 'string') return undefined;
			const parent =
				path.length === 1 ? positionDoc.contents : positionDoc.getIn(path.slice(0, -1), true);
			if (isMap(parent)) {
				const pair = parent.items.find((it) => isScalar(it.key) && it.key.value === last);
				if (pair && isNode(pair.key) && pair.key.range) {
					return lineCounter.linePos(pair.key.range[0]).col - 1;
				}
			}
		} catch {
			// bad path -> no indent
		}
		return undefined;
	};

	// The 0-based column where the VALUE node at a path begins (for a scalar in a
	// sequence, the start of that item), so a replace-fix can anchor to the exact token
	// instead of the first substring match on the line. undefined if unresolved.
	const columnOf = (path: (string | number)[]): number | undefined => {
		if (!positionDoc) return undefined;
		try {
			const node = positionDoc.getIn(path, true);
			if (isNode(node) && node.range) {
				return lineCounter.linePos(node.range[0]).col - 1;
			}
		} catch {
			// bad path -> no column
		}
		return undefined;
	};

	return { doc, parseError, lineOf, indentOf, columnOf };
}
