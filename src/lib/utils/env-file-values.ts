/**
 * Reading a `.env` value the way `docker compose` reads it.
 *
 * Two things a naive `split('=')` gets wrong, both reported against git stacks where
 * Dockhand parses the file itself instead of handing it to compose:
 *
 *   DIRECTORY=/srv/data
 *   LOCATION="${DIRECTORY}/immich"
 *
 * The quotes belong to the file format, not to the value, and `${DIRECTORY}` refers to
 * an earlier line. Kept verbatim, the label reads `"${DIRECTORY}/immich"` and a bind
 * mount using it resolves to nothing - which compose then reports as a volume that does
 * not exist, giving no hint that a variable was the problem.
 *
 * Pure, so the rules can be tested against what compose actually does.
 */

/** A value's surrounding quotes, which are syntax rather than content. */
export function unquote(raw: string): string {
	const v = raw.trim();
	if (v.length < 2) return v;
	const first = v[0];
	if ((first === '"' || first === "'") && v[v.length - 1] === first) {
		return v.slice(1, -1);
	}
	return v;
}

/**
 * `${NAME}` and `$NAME` replaced from what is already known, with `$$` left as one
 * literal dollar.
 *
 * `$$` is compose's escape, and it is what people write for a password, a Traefik
 * pattern or a bcrypt hash containing a dollar - so eating it truncates the value
 * silently. A name with no value becomes empty, as in a shell, which is what
 * `${NAME:?...}` exists to complain about. Single quotes are literal in a `.env` file,
 * so a single-quoted value is returned untouched.
 *
 * One pass, not three: a value that expands to text containing `$NAME` must not have
 * that rescanned as another reference.
 */
export function expandValue(raw: string, known: Readonly<Record<string, string>>): string {
	const trimmed = raw.trim();

	// Single quotes are literal throughout: no escapes, no references.
	if (trimmed.startsWith("'")) return unquote(trimmed);

	// Double quotes take shell escape sequences first, then substitution.
	if (trimmed.startsWith('"')) return substitute(expandEscapes(unquote(trimmed)), known);

	// Unquoted: a hash PRECEDED BY A SPACE starts a comment, and the trailing space goes
	// with it. A hash inside the value - a colour, a URL fragment - is part of it.
	const comment = trimmed.indexOf(' #');
	const value = comment === -1 ? trimmed : trimmed.slice(0, comment).trimEnd();
	return substitute(value, known);
}

/**
 * The escape sequences a double-quoted value carries.
 *
 * `\$` becomes the `$$` form so the substitution pass reads it as one literal dollar,
 * `\0NNN` is octal, and the rest are the usual shell escapes. Anything outside the set
 * is left as written rather than guessed at.
 */
function expandEscapes(value: string): string {
	const SIMPLE: Record<string, string> = {
		a: '\x07',
		b: '\b',
		c: '',
		f: '\f',
		n: '\n',
		r: '\r',
		t: '\t',
		v: '\v',
		'"': '"',
		'\\': '\\'
	};

	return value.replace(/\\(?:[abcfnrtv$"\\]|0\d{0,3})/g, (match) => {
		if (match === '\\$') return '$$';
		if (match.startsWith('\\0')) {
			const code = parseInt(match.slice(2) || '0', 8);
			return Number.isNaN(code) ? match : String.fromCharCode(code);
		}
		return SIMPLE[match[1]] ?? match;
	});
}

/**
 * One left-to-right pass over a value, replacing every reference it finds.
 *
 * Written as a scan rather than a regex because a default may itself hold a reference
 * (`${A:-${B}/x}`) and brace counting is what tells its end from the value's own text.
 * A pass never re-reads what it produced, so a resolved value containing `$NAME` stays
 * as it is.
 */
function substitute(value: string, known: Readonly<Record<string, string>>): string {
	let out = '';
	let i = 0;
	while (i < value.length) {
		const dollar = value.indexOf('$', i);
		if (dollar === -1) return out + value.slice(i);
		out += value.slice(i, dollar);

		const next = value[dollar + 1];
		if (next === '$') {
			// Compose's escape for a literal dollar.
			out += '$';
			i = dollar + 2;
		} else if (next === '{') {
			const end = closingBrace(value, dollar + 1);
			if (end === -1) {
				// Unbalanced: nothing to resolve, so the text stands.
				return out + value.slice(dollar);
			}
			out += resolveReference(value.slice(dollar + 2, end), known);
			i = end + 1;
		} else if (next && /[A-Za-z_]/.test(next)) {
			let end = dollar + 1;
			while (end < value.length && /[A-Za-z0-9_]/.test(value[end])) end++;
			out += known[value.slice(dollar + 1, end)] ?? '';
			i = end;
		} else {
			// A dollar that starts no name - a price, a trailing one - is just text.
			out += '$';
			i = dollar + 1;
		}
	}
	return out;
}

/** The `}` matching the `{` at `open`, or -1 when the braces do not balance. */
function closingBrace(value: string, open: number): number {
	let depth = 0;
	for (let i = open; i < value.length; i++) {
		if (value[i] === '{') depth++;
		else if (value[i] === '}' && --depth === 0) return i;
	}
	return -1;
}

/**
 * The inside of a `${...}`, including the forms that carry a default or an alternative.
 *
 * Measured against compose: `:-` and `-` fall back when the name is unset or empty,
 * `:+` yields its alternative only when the name HAS a value, and a default may itself
 * contain a reference. `:?` explains a missing value to a person; there is nobody to
 * tell here, so it resolves like the plain form and lets the deploy report it.
 */
function resolveReference(body: string, known: Readonly<Record<string, string>>): string {
	const op = body.search(/[:\-+?]/);
	if (op === -1) return known[body] ?? '';

	const name = body.slice(0, op);
	const rest = body.slice(op);
	const value = known[name];

	// The colon is what makes an EMPTY value count as absent. Without it, only an
	// unset name does - so ${EMPTY-d} keeps the empty value while ${EMPTY:-d} takes
	// the default.
	if (rest.startsWith(':+')) return value ? substitute(rest.slice(2), known) : '';
	if (rest.startsWith('+')) {
		return value !== undefined ? substitute(rest.slice(1), known) : '';
	}
	if (rest.startsWith(':-')) return value || substitute(rest.slice(2), known);
	if (rest.startsWith('-')) return value ?? substitute(rest.slice(1), known);
	// `:?` / `?` ask to stop rather than deploy with a hole, which compose does when it
	// reads the file itself. Nothing here can refuse a deploy, so the value resolves
	// like the plain form and compose raises it on its own pass.
	return value ?? '';
}

/**
 * Resolve a file's values against each other, in the order they were written.
 *
 * Only earlier lines are visible to a later one, which is how a shell and compose read
 * a file; a forward reference is empty rather than an error.
 */
export function resolveEnvValues(
	entries: readonly (readonly [string, string])[]
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, raw] of entries) {
		out[key] = expandValue(raw, out);
	}
	return out;
}

/**
 * A resolved value written back into a `.env` file compose will read again.
 *
 * Whatever writes that file hands compose a second interpolation pass, and the bare
 * `KEY=value` form loses more than dollars to it: a hash after a space becomes a
 * comment, surrounding spaces are trimmed, and a value starting with a quote breaks the
 * file outright. Quoting the whole value makes it one token, and escaping backslash,
 * quote and dollar - in that order - carries it through the pass unchanged.
 */
export function quoteForEnvFile(value: string): string {
	const escaped = value
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\$/g, '$$$$');
	return `"${escaped}"`;
}

