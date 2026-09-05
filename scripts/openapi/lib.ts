/**
 * OpenAPI generation — shared engine.
 *
 * Used by `scripts/generate-openapi.ts` in three modes (generate / --check /
 * --scaffold). Everything here is pure, dependency-free (plain node:fs +
 * node:path) — no swagger-jsdoc (CJS-only, the thing PR #816 avoided), no
 * AST framework. A regex/string-scan approach is sufficient because this
 * codebase is 100% consistent in its `export const METHOD:` convention
 * (verified during Phase A: 0 exceptions across 232 route files).
 *
 * Three responsibilities, kept separate so --check and --scaffold can reuse
 * exactly what `generate` uses (no drift between "what the spec says" and
 * "what the checker validates against"):
 *
 *   1. Route discovery       — filesystem walk -> path/method/tag (ZERO manual steps)
 *   2. Annotation parsing    — optional @openapi JSDoc blocks -> rich operations
 *   3. Static analysis       — best-effort extraction of query params / status
 *                              codes / body fields ACTUALLY used in a handler's
 *                              source, so --check can flag drift between code
 *                              and annotation, and --scaffold can propose a
 *                              code-grounded starting annotation.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface DiscoveredRoute {
	filePath: string; // ABSOLUTE path — callers relativize for display as needed
	openapiPath: string; // e.g. /api/stacks/{name}/env
	pathParams: string[]; // e.g. ['name']
	methods: HttpMethod[];
	tag: string;
}

export type MiniSchema =
	| { kind: 'string' | 'integer' | 'number' | 'boolean' }
	| { kind: 'object'; properties: Record<string, MiniSchema>; required: string[] }
	| { kind: 'array'; items: MiniSchema };

export interface ParamAnnotation {
	type: string;
	required: boolean;
	description: string;
}

export interface ResponseAnnotation {
	schema?: MiniSchema;
	description: string;
	example?: unknown;
}

export interface HandlerAnnotation {
	summary?: string;
	/** Optional long-form explanation (OpenAPI operation.description) — use for
	 *  context the one-line summary can't carry: purpose, read-only/write
	 *  semantics, or where a related write operation lives. Markdown-safe. */
	description?: string;
	query: Record<string, ParamAnnotation>;
	path: Record<string, ParamAnnotation>;
	body?: MiniSchema;
	bodyExample?: unknown;
	/** A non-JSON raw request body, e.g. `body-raw: application/x-tar The image tar`. */
	bodyRaw?: { mediaType: string; description: string };
	/** A multipart/form-data body: one file field, e.g.
	 *  `body-multipart: files:binary[]! One or more files`. */
	bodyMultipart?: { field: string; type: string; array: boolean; required: boolean; description: string };
	responses: Record<string, ResponseAnnotation>;
	/** Raw block text, kept only for --check's orphan-block diagnostics. */
	raw: string;
}

export type InferredScalarType = 'string' | 'integer' | 'boolean';

export interface QueryParamAnalysis {
	name: string;
	type: InferredScalarType;
}

export interface StaticAnalysis {
	queryParams: QueryParamAnalysis[]; // deduped, sorted by name, with inferred scalar type
	pathParamTypes: Record<string, InferredScalarType>; // inferred from parseInt(params.X)/Number(params.X) — string params not in here default to 'string'
	statusCodes: string[]; // deduped, sorted, as strings ("200", "403", ...)
	bodyFields: string[]; // deduped, sorted, top-level destructured field names
}

// ---------------------------------------------------------------------------
// 1. Route discovery
// ---------------------------------------------------------------------------

export function walkServerFiles(rootDirs: string[]): string[] {
	const acc: string[] = [];
	function walk(dir: string) {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return; // root dir may not exist (e.g. optional feature dirs) — skip silently
		}
		for (const entry of entries) {
			const full = join(dir, entry);
			const st = statSync(full);
			if (st.isDirectory()) walk(full);
			else if (entry === '+server.ts') acc.push(full);
		}
	}
	for (const root of rootDirs) walk(root);
	return acc;
}

export function toOpenApiPath(serverFile: string, routesRoot: string): { path: string; params: string[] } {
	const rel = relative(routesRoot, dirname(serverFile));
	const segments = rel.split('/').filter(Boolean);
	const params: string[] = [];
	const converted = segments.map((seg) => {
		const m = seg.match(/^\[(\.\.\.)?([^\]=]+?)(=.*)?\]$/);
		if (m) {
			const isRest = !!m[1];
			const name = m[2];
			params.push(name);
			return isRest ? `{${name}*}` : `{${name}}`;
		}
		return seg;
	});
	return { path: '/' + converted.join('/'), params };
}

export function deriveTag(openapiPath: string): string {
	const segments = openapiPath.split('/').filter(Boolean);
	if (segments[0] === 'api') return segments[1] ?? 'root';
	return segments[0] ?? 'root';
}

export function extractMethods(content: string): HttpMethod[] {
	const found: HttpMethod[] = [];
	for (const m of HTTP_METHODS) {
		if (new RegExp(`^export const ${m}\\s*:`, 'm').test(content)) found.push(m);
	}
	return found;
}

/**
 * Rough per-method body isolation: from `export const METHOD:` to the next
 * `export const <OTHER_METHOD>:` (or EOF). Not a real parser — good enough
 * for the static-analysis heuristics below, which only need "roughly the
 * right chunk of source", not a compiled AST.
 */
export function splitMethodBodies(content: string): Partial<Record<HttpMethod, string>> {
	const positions: { method: HttpMethod; start: number }[] = [];
	for (const m of HTTP_METHODS) {
		const re = new RegExp(`^export const ${m}\\s*:`, 'm');
		const match = re.exec(content);
		if (match) positions.push({ method: m, start: match.index! });
	}
	positions.sort((a, b) => a.start - b.start);
	const result: Partial<Record<HttpMethod, string>> = {};
	for (let idx = 0; idx < positions.length; idx++) {
		const start = positions[idx].start;
		const end = idx + 1 < positions.length ? positions[idx + 1].start : content.length;
		result[positions[idx].method] = content.slice(start, end);
	}
	return result;
}

export function discoverRoutes(rootDirs: string[], routesRoot: string): { routes: DiscoveredRoute[]; skipped: { filePath: string; reason: string }[]; fileContents: Map<string, string> } {
	const routes: DiscoveredRoute[] = [];
	const skipped: { filePath: string; reason: string }[] = [];
	const fileContents = new Map<string, string>();
	const files = walkServerFiles(rootDirs);

	for (const file of files) {
		const content = readFileSync(file, 'utf-8');
		fileContents.set(file, content);
		const methods = extractMethods(content);
		if (methods.length === 0) {
			skipped.push({ filePath: file, reason: 'no export const <METHOD>: match found' });
			continue;
		}
		const { path, params } = toOpenApiPath(file, routesRoot);
		routes.push({ filePath: file, openapiPath: path, pathParams: params, methods, tag: deriveTag(path) });
	}
	return { routes, skipped, fileContents };
}

// ---------------------------------------------------------------------------
// 2. Annotation parsing — @openapi JSDoc blocks with a compact typed mini-DSL
// ---------------------------------------------------------------------------
//
//   /**
//    * @openapi
//    * summary: <text>
//    * description: <text>                        (optional; longer explanation
//    *                                              than summary — purpose,
//    *                                              read-only/write semantics,
//    *                                              pointer to a related endpoint)
//    * query: <name>:<type>[!] <description>     (repeatable)
//    * path:  <name>:<type>[!] <description>      (repeatable; enriches an
//    *                                             auto-detected {name} segment)
//    * body: <mini-schema>
//    * body-example: <json>
//    * resp-<code>: <mini-schema>  OR  resp-<code>: <plain text>
//    * resp-<code>-desc: <text>
//    * resp-<code>-example: <json>
//    */
//
// mini-schema := 'string'|'integer'|'number'|'boolean'|'object' | '{' (name':'type'!'?','?)* '}' | 'array<' type '>'
// (bare 'object' = an opaque object with no declared properties; use '{...}' for a documented shape)

export function parseMiniSchema(str: string): MiniSchema {
	let i = 0;
	const s = str;

	function skipWs() {
		while (i < s.length && /\s/.test(s[i])) i++;
	}

	function parseType(): MiniSchema {
		skipWs();
		if (s[i] === '{') return parseObject();
		if (s[i] === '[') {
			// bracket array form: [T]
			i++;
			const items = parseType();
			skipWs();
			if (s[i] === ']') i++;
			return { kind: 'array', items };
		}
		if (s.slice(i, i + 6) === 'array<') {
			i += 6;
			const items = parseType();
			skipWs();
			if (s[i] === '>') i++;
			return { kind: 'array', items };
		}
		const start = i;
		while (i < s.length && /[a-zA-Z0-9_]/.test(s[i])) i++;
		// Guarantee forward progress: an unrecognized char (not a word, brace, or
		// bracket) must still advance i, or the parseObject loop spins forever.
		if (i === start) i++;
		const word = s.slice(start, i) || 'string';
		if (word === 'integer' || word === 'number' || word === 'boolean' || word === 'string') return { kind: word };
		// Bare `object` (no `{...}` shape given) — an opaque/untyped object, used
		// throughout the codebase for fields whose internal shape isn't part of
		// the documented contract (e.g. `severity:object`, `envVars:object`,
		// `config:object`). Without this branch it silently fell through to the
		// generic `string` fallback below, so every one of these fields was
		// documented in static/openapi.json as `{ "type": "string" }` instead of
		// `{ "type": "object" }` — wrong for any client generated strictly from
		// the spec (a typed SDK, an MCP server mirroring the schema, ...).
		if (word === 'object') return { kind: 'object', properties: {}, required: [] };
		return { kind: 'string' };
	}

	function parseObject(): MiniSchema {
		i++; // '{'
		const properties: Record<string, MiniSchema> = {};
		const required: string[] = [];
		skipWs();
		while (i < s.length && s[i] !== '}') {
			skipWs();
			const nameStart = i;
			while (i < s.length && /[a-zA-Z0-9_]/.test(s[i])) i++;
			const name = s.slice(nameStart, i);
			skipWs();
			if (s[i] === ':') i++;
			const type = parseType();
			skipWs();
			let isRequired = false;
			if (s[i] === '!') {
				isRequired = true;
				i++;
			}
			if (name) {
				properties[name] = type;
				if (isRequired) required.push(name);
			}
			skipWs();
			if (s[i] === ',') {
				i++;
				skipWs();
			}
		}
		if (s[i] === '}') i++;
		return { kind: 'object', properties, required };
	}

	return parseType();
}

export function miniSchemaToOpenApi(schema: MiniSchema): Record<string, unknown> {
	switch (schema.kind) {
		case 'object': {
			const out: Record<string, unknown> = {
				type: 'object',
				properties: Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, miniSchemaToOpenApi(v)]))
			};
			if (schema.required.length > 0) out.required = schema.required;
			return out;
		}
		case 'array':
			return { type: 'array', items: miniSchemaToOpenApi(schema.items) };
		default:
			return { type: schema.kind };
	}
}

export function synthesizeExample(schema: MiniSchema): unknown {
	switch (schema.kind) {
		case 'object':
			return Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, synthesizeExample(v)]));
		case 'array':
			return [synthesizeExample(schema.items)];
		case 'integer':
		case 'number':
			return 0;
		case 'boolean':
			return true;
		default:
			return 'string';
	}
}

// Both halves use a negated-lookahead scan `(?:(?!\*\/)[\s\S])*?` instead of
// plain `[\s\S]*?` so the match can never cross a `*/` — i.e. it can only ever
// consume characters that belong to ONE comment block. Without this guard, a
// handler preceded by an earlier, unrelated `/** file-header */` JSDoc comment
// (with no `@openapi` of its own) makes the lazy quantifier skip past that
// comment's own `*/` and swallow every line of CODE in between as if it were
// part of the annotation body — including any `key: value,` object-literal
// line (e.g. `description: sys.description,`) that happens to match a
// recognized annotation key. Real `/** ... */` comments can never contain a
// literal `*/` (that would end the comment in valid JS/TS), so this
// restriction never rejects a legitimate block.
const ANNOTATION_BLOCK_RE =
	/\/\*\*((?:(?!\*\/)[\s\S])*?@openapi\b(?:(?!\*\/)[\s\S])*?)\*\/\s*export const (GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s*:/g;

/** Every `@openapi` marker found in a file, regardless of whether it could be
 *  matched to a following `export const METHOD:` — used by --check's
 *  "orphan JSDoc" gate to catch a block that's present but detached (typo'd
 *  method, comment not directly above the export, etc). */
export function countRawMarkers(content: string): number {
	return (content.match(/@openapi\b/g) ?? []).length;
}

export function parseAnnotations(content: string): Partial<Record<HttpMethod, HandlerAnnotation>> {
	const result: Partial<Record<HttpMethod, HandlerAnnotation>> = {};
	let m: RegExpExecArray | null;
	ANNOTATION_BLOCK_RE.lastIndex = 0;
	while ((m = ANNOTATION_BLOCK_RE.exec(content)) !== null) {
		const [raw, blockBody, method] = m;
		const lines = blockBody
			.split('\n')
			.map((l) => l.replace(/^\s*\*\s?/, '').trim())
			.filter((l) => l && l !== '@openapi');

		const annotation: HandlerAnnotation = { query: {}, path: {}, responses: {}, raw };
		const respDescOverride: Record<string, string> = {};
		const respExampleOverride: Record<string, unknown> = {};

		for (const line of lines) {
			const kv = line.match(/^([a-z0-9-]+)\s*:\s*(.+)$/i);
			if (!kv) continue;
			const [, key, rawValue] = kv;

			if (key === 'summary') {
				annotation.summary = rawValue;
				continue;
			}
			if (key === 'description') {
				annotation.description = rawValue;
				continue;
			}
			if (key === 'query' || key === 'path') {
				const pm = rawValue.match(/^([a-zA-Z0-9_]+)\s*:\s*([a-zA-Z0-9_]+)(!)?\s*(.*)$/);
				if (pm) {
					const [, name, type, required, description] = pm;
					(annotation[key] as Record<string, ParamAnnotation>)[name] = {
						type,
						required: !!required,
						description: description.trim()
					};
				}
				continue;
			}
			if (key === 'body') {
				annotation.body = parseMiniSchema(rawValue);
				continue;
			}
			if (key === 'body-example') {
				try {
					annotation.bodyExample = JSON.parse(rawValue);
				} catch {
					/* ignore malformed example */
				}
				continue;
			}
			if (key === 'body-raw') {
				// `body-raw: <media-type> <description>` - a non-JSON raw body.
				const rm = rawValue.match(/^(\S+)\s*(.*)$/);
				if (rm) annotation.bodyRaw = { mediaType: rm[1], description: rm[2].trim() };
				continue;
			}
			if (key === 'body-multipart') {
				// `body-multipart: <field>:<type>[]? [!] <description>` - a multipart body.
				const mm = rawValue.match(/^([a-zA-Z0-9_]+)\s*:\s*([a-zA-Z0-9_]+)(\[\])?(!)?\s*(.*)$/);
				if (mm) {
					const [, field, type, array, required, description] = mm;
					annotation.bodyMultipart = {
						field,
						type,
						array: !!array,
						required: !!required,
						description: description.trim()
					};
				}
				continue;
			}
			const respMatch = key.match(/^resp-(\d{3})(-desc|-example)?$/);
			if (respMatch) {
				const [, code, suffix] = respMatch;
				if (suffix === '-desc') respDescOverride[code] = rawValue;
				else if (suffix === '-example') {
					try {
						respExampleOverride[code] = JSON.parse(rawValue);
					} catch {
						/* ignore malformed example */
					}
				} else {
					const looksLikeSchema = /^(\{|array<)/.test(rawValue.trim());
					annotation.responses[code] = looksLikeSchema
						? { schema: parseMiniSchema(rawValue), description: code === '200' ? 'Successful response' : 'Response' }
						: { description: rawValue };
				}
			}
		}

		for (const [code, desc] of Object.entries(respDescOverride)) {
			annotation.responses[code] = { ...(annotation.responses[code] ?? { description: desc }), description: desc };
		}
		for (const [code, ex] of Object.entries(respExampleOverride)) {
			annotation.responses[code] = { ...(annotation.responses[code] ?? { description: 'Response' }), example: ex };
		}

		result[method as HttpMethod] = annotation;
	}
	return result;
}

// ---------------------------------------------------------------------------
// 3. Static analysis — code-grounded facts used by --check (drift) and
//    --scaffold (starting point). Deliberately conservative: false negatives
//    (missing a query param) are more likely than false positives, so this
//    is a HELPER, not a source of truth — the annotation is still authored
//    by a human who reads the handler.
// ---------------------------------------------------------------------------

function parseDestructuredFields(inner: string): string[] {
	// Naive top-level split on commas. Doesn't handle nested destructuring
	// (`{ a: { b } }`) correctly, but every body in this codebase destructures
	// shallowly (verified via spot-check across the annotated + scaffold sets).
	const fields: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of inner) {
		if (ch === '{' || ch === '[') depth++;
		if (ch === '}' || ch === ']') depth--;
		if (ch === ',' && depth === 0) {
			fields.push(current);
			current = '';
		} else {
			current += ch;
		}
	}
	if (current.trim()) fields.push(current);
	return fields
		.map((f) => f.split(':')[0].split('=')[0].trim())
		.filter((f) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(f));
}

/**
 * Type inference is deliberately conservative: a query/path param defaults to
 * 'string' unless the code contains an UNAMBIGUOUS, textually-local signal
 * (parseInt/Number wrapping the same local variable or the same literal
 * searchParams key, or a `=== 'true'`/`!== 'false'` boolean comparison).
 * When in doubt this returns 'string' — never a guessed 'integer'/'boolean'
 * that isn't backed by an actual pattern match in the source.
 */
function inferQueryParamType(body: string, key: string): InferredScalarType {
	// Direct wrap: parseInt(url.searchParams.get('key')) / Number(url.searchParams.get('key'))
	const directNumRe = new RegExp(`(?:parseInt|Number)\\(\\s*url\\.searchParams\\.get\\(\\s*['"]${key}['"]\\s*\\)`);
	if (directNumRe.test(body)) return 'integer';

	// Two-step: const NAME = url.searchParams.get('key'); ... parseInt(NAME) / Number(NAME)
	const assignRe = new RegExp(`(?:const|let)\\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\\s*=\\s*url\\.searchParams\\.get\\(\\s*['"]${key}['"]\\s*\\)`);
	const assignMatch = assignRe.exec(body);
	if (assignMatch) {
		const varName = assignMatch[1];
		const numRe = new RegExp(`(?:parseInt|Number)\\(\\s*${varName}\\b`);
		if (numRe.test(body)) return 'integer';
		const boolRe = new RegExp(`\\b${varName}\\s*(?:===|!==)\\s*['"](?:true|false)['"]`);
		if (boolRe.test(body)) return 'boolean';
	}

	// Direct boolean comparison: url.searchParams.get('key') === 'true' / !== 'false'
	const directBoolRe = new RegExp(`url\\.searchParams\\.get\\(\\s*['"]${key}['"]\\s*\\)\\s*(?:===|!==)\\s*['"](?:true|false)['"]`);
	if (directBoolRe.test(body)) return 'boolean';

	return 'string';
}

function inferPathParamType(body: string, name: string): InferredScalarType {
	const numRe = new RegExp(`(?:parseInt|Number)\\(\\s*params\\.${name}\\b`);
	return numRe.test(body) ? 'integer' : 'string';
}

export function analyzeHandlerBody(body: string, pathParamNames: string[] = []): StaticAnalysis {
	const queryKeys = new Set<string>();
	const qRe = /url\.searchParams\.get(?:All)?\(\s*['"]([a-zA-Z0-9_]+)['"]\s*\)/g;
	let qm;
	while ((qm = qRe.exec(body)) !== null) queryKeys.add(qm[1]);
	const queryParams: QueryParamAnalysis[] = [...queryKeys]
		.sort()
		.map((name) => ({ name, type: inferQueryParamType(body, name) }));

	const pathParamTypes: Record<string, InferredScalarType> = {};
	for (const name of pathParamNames) {
		const type = inferPathParamType(body, name);
		if (type !== 'string') pathParamTypes[name] = type; // only record non-default to keep the map small
	}

	const statusCodes = new Set<string>();
	const statusRe = /\bstatus:\s*(\d{3})\b/g;
	let sm;
	while ((sm = statusRe.exec(body)) !== null) statusCodes.add(sm[1]);
	const errorRe = /\berror\(\s*(\d{3})/g;
	let em;
	while ((em = errorRe.exec(body)) !== null) statusCodes.add(em[1]);
	// SvelteKit `redirect(3xx, location)` — e.g. `throw redirect(302, '/login')`.
	// Without this, an annotated resp-3xx on a redirect-only handler is flagged
	// as stale drift by Gate 4, even though the code genuinely emits it.
	const redirectRe = /\bredirect\(\s*(\d{3})/g;
	let rm;
	while ((rm = redirectRe.exec(body)) !== null) statusCodes.add(rm[1]);

	const bodyFields = new Set<string>();
	// `const { a, b } = await request.json();` and `const { a, b } = body;`
	const destructureRe = /const\s*\{([^}]*)\}\s*=\s*(?:await\s+)?(?:request\.json\(\)|body)\b/g;
	let dm;
	while ((dm = destructureRe.exec(body)) !== null) {
		for (const f of parseDestructuredFields(dm[1])) bodyFields.add(f);
	}

	return {
		queryParams,
		pathParamTypes,
		statusCodes: [...statusCodes].sort(),
		bodyFields: [...bodyFields].sort()
	};
}

// ---------------------------------------------------------------------------
// PUBLIC_PATHS extraction (from hooks.server.ts) — auth-exemption discovery
// ---------------------------------------------------------------------------

export function extractPublicPaths(hooksFile: string): string[] {
	const content = readFileSync(hooksFile, 'utf-8');
	const m = content.match(/const PUBLIC_PATHS\s*=\s*\[([\s\S]*?)\];/);
	if (!m) return [];
	const paths: string[] = [];
	const strRe = /'([^']+)'/g;
	let sm;
	while ((sm = strRe.exec(m[1])) !== null) paths.push(sm[1]);
	return paths;
}

// Two exceptions hardcoded directly in isPublicPath() as regexes (webhook
// signature/secret auth instead of session/token) — not expressible as a
// simple PUBLIC_PATHS prefix string. The one manual special-case this
// generator needs; documented in the research doc's coverage-gap section.
export const PUBLIC_PATH_REGEXES = [/^\/api\/git\/stacks\/\d+\/webhook$/, /^\/api\/git\/webhook\/\d+$/];

export function isPublic(openapiPath: string, publicPaths: string[]): boolean {
	if (publicPaths.some((p) => openapiPath === p || openapiPath.startsWith(p + '/'))) return true;
	const asConcretePath = openapiPath.replace(/\{[^}]+\}/g, '1');
	return PUBLIC_PATH_REGEXES.some((re) => re.test(asConcretePath));
}
