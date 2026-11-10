import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseRawContent } from '../src/lib/utils/env-panel-core';
import { isGitStackOverride } from '../src/lib/env-merge';
import { unquote, expandValue, resolveEnvValues, quoteForEnvFile, envValueFromText, envValueToText, parseEnvFileForForm, envValueToTextPreserving } from '../src/lib/utils/env-file-values';

// Every expectation below was measured against `docker compose config` with the same
// .env file, so these pin real behaviour rather than an assumption about it.
describe('quotes belong to the file, not the value', () => {
	test('double and single quotes are stripped', () => {
		expect(unquote('"/srv/data"')).toBe('/srv/data');
		expect(unquote("'/srv/data'")).toBe('/srv/data');
	});

	test('an unquoted value is untouched, and so is a lone quote', () => {
		expect(unquote('/srv/data')).toBe('/srv/data');
		expect(unquote('"')).toBe('"');
		expect(unquote('say "hi"')).toBe('say "hi"');
	});

	test('mismatched quotes are not a pair', () => {
		expect(unquote(`"/srv'`)).toBe(`"/srv'`);
	});
});

describe('a value referring to another', () => {
	const known = { BASE: '/srv' };

	// The reported case: the label read "${DIRECTORY}/immich" verbatim, and a bind
	// mount using it resolved to nothing.
	test('${NAME} is replaced, quotes and all', () => {
		expect(expandValue('"${BASE}/immich"', known)).toBe('/srv/immich');
	});

	test('the brace-less form works too', () => {
		expect(expandValue('$BASE/bare', known)).toBe('/srv/bare');
	});

	test('single quotes are literal, as in a shell', () => {
		expect(expandValue("'${BASE}/sq'", known)).toBe('${BASE}/sq');
	});

	test('an unknown name becomes empty rather than staying as text', () => {
		expect(expandValue('${NOPE}/x', known)).toBe('/x');
	});

	test('several references in one value are all replaced', () => {
		expect(expandValue('${BASE}/a/${BASE}/b', known)).toBe('/srv/a//srv/b');
	});

	test('text with no reference is returned as it is', () => {
		expect(expandValue('plain/path', known)).toBe('plain/path');
		expect(expandValue('', known)).toBe('');
	});
});

describe('a whole file', () => {
	test('a later line sees an earlier one', () => {
		const out = resolveEnvValues([
			['DIRECTORY', '/path/to/base/directory'],
			['LOCATION', '"${DIRECTORY}/immich"']
		]);
		expect(out).toEqual({
			DIRECTORY: '/path/to/base/directory',
			LOCATION: '/path/to/base/directory/immich'
		});
	});

	// Measured: compose resolves a forward reference to nothing, not to the later value.
	test('a reference to a line further down is empty', () => {
		const out = resolveEnvValues([
			['FWD', '${LATER}/fwd'],
			['LATER', '/later']
		]);
		expect(out.FWD).toBe('/fwd');
		expect(out.LATER).toBe('/later');
	});

	test('a chain resolves through every step', () => {
		const out = resolveEnvValues([
			['A', '/a'],
			['B', '${A}/b'],
			['C', '${B}/c']
		]);
		expect(out.C).toBe('/a/b/c');
	});

	test('a later line wins on a repeated key', () => {
		expect(resolveEnvValues([['K', 'one'], ['K', 'two']]).K).toBe('two');
	});

	test('an empty file gives nothing', () => {
		expect(resolveEnvValues([])).toEqual({});
	});
});

describe('a literal dollar', () => {
	const known = { BASE: '/srv' };

	// $$ is compose's escape and what people write for passwords, Traefik patterns and
	// bcrypt hashes. Eating it truncates the value with no error - measured against a
	// running container: compose gives pa$word.
	test('$$ becomes one dollar, and the rest of the word survives', () => {
		expect(expandValue('pa$$word', known)).toBe('pa$word');
	});

	test('escapes and references mix in one value', () => {
		expect(expandValue('$$literal-${BASE}-$$end', known)).toBe('$literal-/srv-$end');
	});

	test('a caddy-style pattern keeps its shape', () => {
		expect(expandValue('%{http.request.uri}$$foo', known)).toBe('%{http.request.uri}$foo');
	});

	// One pass: text that arrives BY EXPANSION must not be scanned again, or a value
	// that happens to contain $NAME would be expanded twice.
	test('an expanded value is not rescanned for references', () => {
		const out = resolveEnvValues([
			['A', '$$B'],
			['B', 'x'],
			['C', '${A}']
		]);
		expect(out.A).toBe('$B');
		expect(out.C).toBe('$B');
	});
});

describe('where values are resolved and where they are not', () => {
	// Expanding is for a deploy. A view must hand back the user's own text: it is the
	// diff base the editor decides overrides against, so showing a resolved value there
	// would let a save flatten ${DIRECTORY} into a path for good.
	const git = readFileSync(new URL('../src/lib/server/git.ts', import.meta.url), 'utf8');

	test('the editor read and the previews leave a reference alone', () => {
		// Three reads feed the editor - the stack's repo file and the two repo previews -
		// and all three go through the form reader, which resolves quoting but not a
		// reference. None of them may use the deploy reader.
		const formReads = git.match(/envFileFormVars\(content\)/g) ?? [];
		expect(formReads.length).toBe(3);
		// envFileFormVars is the form reader with a SOPS file's metadata left out.
		const sopsCore = readFileSync(new URL('../src/lib/server/secretproviders/sops-core.ts', import.meta.url), 'utf8');
		const body = sopsCore.slice(sopsCore.indexOf('export function envFileFormVars'));
		expect(body.slice(0, body.indexOf('\n}'))).toContain('parseEnvFileForForm(content)');
		expect(git).not.toContain('expand: false');
		expect(parseEnvFileForForm('A="${B}/y"\n')).toEqual([{ key: 'A', value: '${B}/y' }]);
	});

	test('the deploy paths resolve', () => {
		// Sync and deploy-with-progress pass no options, so they expand.
		expect(git).toContain("parseEnvFileContent(envFileContent, gitStack.stackName)");
		expect(git).toContain("parseEnvFileContent(envContent, gitStack.stackName)");
	});
});

describe('the forms that carry a default or an alternative', () => {
	// Every expectation measured by running the same .env through a container, so these
	// pin compose's behaviour rather than an assumption about it.
	const known = { BASE: '/srv', EMPTY: '' };

	test('a default fills in for a name with no value', () => {
		expect(expandValue('${NOPE:-fallback}', known)).toBe('fallback');
		expect(expandValue('${NOPE-fallback}', known)).toBe('fallback');
	});

	// Measured: compose treats an empty value as absent for BOTH forms here.
	test('an empty value takes the default too', () => {
		expect(expandValue('${EMPTY:-fallback}', known)).toBe('fallback');
	});

	test('a set name keeps its own value', () => {
		expect(expandValue('${BASE:-fallback}', known)).toBe('/srv');
	});

	test('the alternative appears only when the name has a value', () => {
		expect(expandValue('${BASE:+present}', known)).toBe('present');
		expect(expandValue('${NOPE:+present}', known)).toBe('');
		expect(expandValue('${EMPTY:+present}', known)).toBe('');
	});

	test('a default may itself refer to another variable', () => {
		expect(expandValue('${NOPE:-${BASE}/x}', known)).toBe('/srv/x');
	});

	// Nobody is reading a message here, so the value is all this can give; the deploy
	// reports the missing variable itself.


	test('an unbalanced brace is left as written', () => {
		expect(expandValue('${BASE', known)).toBe('${BASE');
	});

	test('a dollar that starts no name is just text', () => {
		expect(expandValue('cost$ 5', known)).toBe('cost$ 5');
		expect(expandValue('ends with $', known)).toBe('ends with $');
	});
});

describe('writing a resolved value back for compose to read', () => {
	// Compose reads the generated file with its own interpolation pass. Measured: the
	// bare KEY=value form loses a hash after a space to a comment, trims surrounding
	// spaces, eats a dollar, and a leading quote breaks the file. Quoting carries all
	// of them through.
	test('a dollar survives', () => {
		expect(quoteForEnvFile('pa$word')).toBe('"pa$$word"');
		expect(quoteForEnvFile('$2y$10$abc')).toBe('"$$2y$$10$$abc"');
	});

	test('a hash and surrounding spaces survive', () => {
		expect(quoteForEnvFile('value # not a comment')).toBe('"value # not a comment"');
		expect(quoteForEnvFile('  padded  ')).toBe('"  padded  "');
	});

	test('a quote and a backslash are escaped, in that order', () => {
		expect(quoteForEnvFile('has"quote')).toBe('"has\\"quote"');
		expect(quoteForEnvFile('back\\slash')).toBe('"back\\\\slash"');
	});

	test('an empty value is still a value', () => {
		expect(quoteForEnvFile('')).toBe('""');
	});
});


describe('escape sequences in a double-quoted value', () => {
	test('the usual shell escapes', () => {
		expect(expandValue('"a\\nb"', {})).toBe('a\nb');
		expect(expandValue('"a\\tb"', {})).toBe('a\tb');
		expect(expandValue('"a\\\\b"', {})).toBe('a\\b');
		expect(expandValue('"say \\"hi\\""', {})).toBe('say "hi"');
	});

	// A backslash-dollar is the other way of writing a literal dollar.
	test('a backslash before a dollar keeps it literal', () => {
		expect(expandValue('"\\$literal"', {})).toBe('$literal');
	});

	test('an octal escape is a character', () => {
		expect(expandValue('"\\0101"', {})).toBe('A');
	});

	// Single quotes are literal throughout, escapes included.
	test('single quotes take no escapes', () => {
		expect(expandValue("'a\\nb'", {})).toBe('a\\nb');
	});
});

describe('a comment after an unquoted value', () => {
	test('a hash preceded by a space starts one', () => {
		expect(expandValue('value # a note', {})).toBe('value');
	});

	// A hash inside the value - a colour, a URL fragment - is part of it.
	test('a hash with no space before it is part of the value', () => {
		expect(expandValue('value#notacomment', {})).toBe('value#notacomment');
		expect(expandValue('#aabbcc', {})).toBe('#aabbcc');
	});

	test('a quoted value keeps its hash', () => {
		expect(expandValue('"value # kept"', {})).toBe('value # kept');
	});
});

describe('variables the author marked as required', () => {
	// Nothing here can refuse a deploy, so `:?` resolves like the plain form and compose
	// raises the missing value on its own pass. The explanation is not left in the value.
	test('an unset required variable resolves empty, message and all', () => {
		expect(expandValue('${NOPE:?set HOST_DATA}', {})).toBe('');
	});

	test('a satisfied requirement resolves to the value', () => {
		expect(expandValue('${A:?why}', { A: 'v' })).toBe('v');
	});

	test('the form without a colon behaves the same way', () => {
		expect(expandValue('${E?why}', { E: '' })).toBe('');
	});
});

describe('what the editor is given', () => {
	// The editor compares what is in the form against what came from the file to decide
	// which variables are the user's own overrides. Handing it a RESOLVED value would
	// make an untouched ${DIRECTORY}/immich look changed, and saving would write the
	// path in place of the variable - the shape of the bug #1112 was closed for.
	const git = readFileSync(new URL('../src/lib/server/git.ts', import.meta.url), 'utf8');

	test('the editor read and the two previews leave a reference alone', () => {
		expect((git.match(/envFileFormVars\(content\)/g) ?? []).length).toBe(3);
		expect(git).not.toContain('expand: false');
	});

	test('an untouched variable is not mistaken for an override', () => {
		const fileVars = { DIRECTORY: '/path/to/base', LOCATION: '"${DIRECTORY}/immich"' };
		const untouched = { key: 'LOCATION', value: '"${DIRECTORY}/immich"', isSecret: false };
		expect(isGitStackOverride(untouched, fileVars)).toBe(false);
	});

	test('a variable the user really changed still counts', () => {
		const fileVars = { PORT: '8080' };
		expect(isGitStackOverride({ key: 'PORT', value: '9090', isSecret: false }, fileVars)).toBe(true);
	});
});

describe('what a Hawser agent is sent', () => {
	// A Hawser stack's .env is read here and injected into the agent's compose process
	// as shell environment, which compose treats as a substitution SOURCE and does not
	// interpolate again. So this side has to resolve the file exactly as compose would
	// when it reads the file itself - otherwise the same .env means one thing on a local
	// stack and another on a remote one.
	//
	// Each expectation below was read out of a running container (env -0) after compose
	// resolved the same line from an env_file, on docker compose v2.
	const asComposeResolvesIt: [string, string, string][] = [
		['an unquoted apr1 hash loses its variable-looking segments',
			'admin:$apr1$Xy9$8fJq', 'admin:$8fJq'],
		['a double-quoted value is still interpolated',
			'"admin:$apr1$keep"', 'admin:'],
		['single quotes keep a hash intact, which is the fix to advise',
			"'admin:$apr1$lit'", 'admin:$apr1$lit'],
		['a hash after a space starts a comment',
			'secret #1 pass', 'secret'],
		['$$ is the escape for one literal dollar',
			'pa$$word', 'pa$word']
	];

	for (const [what, raw, expected] of asComposeResolvesIt) {
		test(what, () => {
			expect(expandValue(raw, {})).toBe(expected);
		});
	}

	test('no read on the way to an agent opts out of resolving', () => {
		// Shipping the raw text would hand the agent a value the local path never
		// produces, which is the divergence this parser exists to close. Only the editor
		// and the repo previews keep the raw text, and those live in git.ts.
		const stacks = readFileSync(new URL('../src/lib/server/stacks.ts', import.meta.url), 'utf8');
		const calls = stacks.match(/parseEnvFileContent\([^;]*?\)/g) ?? [];
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.filter((c) => c.includes('expand: false'))).toEqual([]);
	});
});

/**
 * The form/text pair for the env-var panel.
 *
 * A row holds the value; the .env text holds it in the file's syntax. The two functions
 * are inverses, so a value the user typed survives being written out and read back - a
 * quote left on the way in reaches the container as part of a secret, and a quote lost
 * on the way out silently rewrites one.
 */
describe('envValueFromText / envValueToText', () => {
	test('quotes are syntax, so the form shows the value without them', () => {
		expect(envValueFromText('"bar"')).toBe('bar');
		expect(envValueFromText("'qux'")).toBe('qux');
		expect(envValueFromText('raw')).toBe('raw');
	});

	test('a reference is the user\'s text and is left for them to see', () => {
		// expandValue resolves these for a deploy; a form must not, or an edit saved
		// from that view flattens the variable for good.
		expect(envValueFromText('"${DIRECTORY}/immich"')).toBe('${DIRECTORY}/immich');
		expect(envValueFromText('$PLAIN')).toBe('$PLAIN');
	});

	test('a single-quoted value is literal, as in a .env file', () => {
		expect(envValueFromText("'p@$$w0rd#1'")).toBe('p@$$w0rd#1');
		expect(envValueFromText("'no \\n escape'")).toBe('no \\n escape');
	});

	test('double quotes resolve the escapes the writer emits', () => {
		expect(envValueFromText('"a\\"b"')).toBe('a"b');
		expect(envValueFromText('"line\\nbreak"')).toBe('line\nbreak');
		expect(envValueFromText('"tab\\there"')).toBe('tab\there');
		expect(envValueFromText('"back\\\\slash"')).toBe('back\\slash');
		expect(envValueFromText('"dollar$$VAR"')).toBe('dollar$VAR');
		expect(envValueFromText('"dollar$VAR"')).toBe('dollar$VAR');
	});

	test('space around the value is the file\'s layout, not content', () => {
		// `KEY=  "value"` is how a file gets lined up, and compose reads the quotes as
		// syntax there just the same. Without this the quotes would reach the container.
		expect(envValueFromText('  "bar"  ')).toBe('bar');
		expect(envValueFromText("\t'qux'")).toBe('qux');
		expect(envValueFromText('  plain  ')).toBe('plain');
		// A quoted value keeps the space INSIDE its quotes.
		expect(envValueFromText('  "  pad  "  ')).toBe('  pad  ');
	});

	test('an unmatched or partial quote is part of the value', () => {
		expect(envValueFromText('"unclosed')).toBe('"unclosed');
		expect(envValueFromText('mid"dle')).toBe('mid"dle');
		expect(envValueFromText('"')).toBe('"');
	});

	test('only a value the bare form would not survive gets quoted', () => {
		expect(envValueToText('plain')).toBe('plain');
		expect(envValueToText('a b')).toBe('a b');
		expect(envValueToText('')).toBe('');
		expect(envValueToText(' lead')).toBe('" lead"');
		expect(envValueToText('has#hash')).toBe('"has#hash"');
	});

	test('a reference is written through, a literal dollar is escaped', () => {
		// Measured against `docker compose run`: compose resolves ${NAME} and $NAME, and
		// reads $$ as one literal dollar. Escaping a reference here would turn it into
		// that literal and the variable would stop resolving.
		expect(envValueToText('${DIRECTORY}/immich')).toBe('"${DIRECTORY}/immich"');
		expect(envValueToText('$DIRECTORY/immich')).toBe('"$DIRECTORY/immich"');
		expect(envValueToText('cost$5')).toBe('"cost$$5"');
		expect(envValueToText('ends$')).toBe('"ends$$"');
		expect(envValueToText('p@$$w0rd')).toBe('"p@$$$$w0rd"');
		expect(envValueToText('$')).toBe('"$$"');
	});

	test('a line keeps its own spelling when its value is unchanged', () => {
		// A form value cannot say which spelling produced it, so re-spelling a line the
		// user never edited would turn a literal into a reference, or back.
		expect(envValueToTextPreserving('${A}/y', "'${A}/y'")).toBe("'${A}/y'");
		expect(envValueToTextPreserving('${A}/y', '"${A}/y"')).toBe('"${A}/y"');
		expect(envValueToTextPreserving('${A}/y', '${A}/y')).toBe('${A}/y');
		expect(envValueToTextPreserving('p@$$w0rd', 'p@$$w0rd')).toBe('p@$$w0rd');
		// An edited value is written afresh.
		expect(envValueToTextPreserving('other', '"${A}/y"')).toBe('other');
		expect(envValueToTextPreserving('a b', 'plain')).toBe('a b');
	});

	test('an edited value keeps the line\'s quoting style', () => {
		// A single-quoted line is a raw string, so a dollar in it is literal. Rewriting an
		// edited password as double-quoted would make that dollar a reference, and compose
		// would resolve it away.
		expect(envValueToTextPreserving('p@$$new', "'p@$$w0rd'")).toBe("'p@$$new'");
		expect(envValueToTextPreserving('${OTHER}', "'${NOPE}'")).toBe("'${OTHER}'");
		expect(envValueToTextPreserving('c#d', "'a#b'")).toBe("'c#d'");
		// A value a single-quoted line cannot hold falls back to the escaping form.
		expect(envValueToTextPreserving("it's", "'plain'")).toBe('"it\'s"');
		// A double-quoted or bare line is written the normal way.
		expect(envValueToTextPreserving('a b', '"old"')).toBe('a b');
	});

	test('the deploy reading of a value survives a save', () => {
		// Self-consistency of the pair is not enough: the text it writes is handed to
		// compose, so what matters is that resolveEnvValues sees the same value before and
		// after. This is the assertion a form/text round trip alone cannot make.
		const lines = [
			'B=${A}/y',
			'B="${A}/y"',
			"B='${A}/y'",
			'B=p@$$w0rd',
			'B="p@$$w0rd"',
			'B=cost$5',
			"B='p@$$w0rd#1'",
			'B="hello world"',
			"B='\"a\",\"b\"'"
		];
		for (const line of lines) {
			const file = `A=x\n${line}\n`;
			const asEntries = (text: string) =>
				text
					.split('\n')
					.filter((l) => l.trim())
					.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const);
			const before = resolveEnvValues(asEntries(file));
			const original = new Map(asEntries(file));
			const rewritten = parseEnvFileForForm(file)
				.map((row) => `${row.key}=${envValueToTextPreserving(row.value, original.get(row.key) ?? '')}`)
				.join('\n');
			expect(resolveEnvValues(asEntries(rewritten))).toEqual(before);
			// Nothing was edited, so the bytes must not move either.
			expect(`${rewritten}\n`).toBe(file);
		}
	});

	test('every value survives a round trip through the text', () => {
		const values = [
			'bar', 'a b', 'has#hash', 'with"quote', "with'quote", 'dollar$VAR',
			'p@$$w0rd#1', '', '  pad  ', 'a=b', '"already"', "'already'",
			'back\\slash', '#lead', 'trail ', ' lead', 'line\nbreak', 'tab\there',
			'$', '""', "''", 'a"b\'c', '${NESTED}', '$$literal',
			'mixed "q" and $V and #h', '\\', '\\\\', '"'
		];
		for (const value of values) {
			expect(envValueFromText(envValueToText(value))).toBe(value);
		}
	});

	test('the form agrees with what compose hands a service', () => {
		// Measured against a real `docker compose run`: a double-quoted $$ collapses to
		// one dollar, a single-quoted one does not, and \" becomes a quote.
		expect(envValueFromText('"bar"')).toBe('bar');
		expect(envValueFromText("'p@$$w0rd#1'")).toBe('p@$$w0rd#1');
		expect(envValueFromText('"p@$$w0rd#1"')).toBe('p@$w0rd#1');
		expect(envValueFromText('"a\\"b"')).toBe('a"b');
	});
});

/**
 * Three callers fill the same editor form from a `.env` file - the stack env API, the
 * relocate response, and the browser reading a file off disk. Each one parsing the file
 * itself is how the same file comes to show different values depending on how the stack
 * was opened, so this pins the single reader and that nobody rolls their own.
 */
describe('parseEnvFileForForm is the one reader', () => {
	test('a row carries the value, not the file syntax', () => {
		expect(parseEnvFileForForm('FOO="bar"\nBAZ=\'qux\'\nPLAIN=raw\n')).toEqual([
			{ key: 'FOO', value: 'bar' },
			{ key: 'BAZ', value: 'qux' },
			{ key: 'PLAIN', value: 'raw' }
		]);
	});

	test('comments, blanks and unusable lines are skipped', () => {
		const rows = parseEnvFileForForm('# note\n\nNO_EQUALS\n=novalue\n9BAD=x\nGOOD=y\n');
		expect(rows).toEqual([{ key: 'GOOD', value: 'y' }]);
	});

	test('space around the key is layout too', () => {
		// `KEY = value` and a lined-up `KEY   =value` are both ordinary .env; dropping the
		// key's trim makes the name fail validation and the whole row disappear.
		expect(parseEnvFileForForm('FOO = bar\n')).toEqual([{ key: 'FOO', value: 'bar' }]);
		expect(parseEnvFileForForm('FOO\t=bar\n')).toEqual([{ key: 'FOO', value: 'bar' }]);
	});

	test('a commented-out assignment stays out, by its key as well as its hash', () => {
		// `# FOO=bar` is dropped by the key check alone - `# FOO` is not a valid variable
		// name - so the comment skip is what keeps the loop cheap rather than what makes
		// this correct. Either way, a commented-out assignment never comes back as a row.
		expect(parseEnvFileForForm('# FOO=bar\n')).toEqual([]);
		expect(parseEnvFileForForm('#FOO=bar\n')).toEqual([]);
		expect(parseEnvFileForForm('  # FOO=bar\n')).toEqual([]);
	});

	test('it agrees with the panel on the same file', () => {
		// The panel keeps its own loop, to collect a warning per unusable line, so the two
		// can disagree on a VALUE unless both read through envValueFromText. Running the
		// panel's own parser is the only way to see that they do.
		const content = 'A="bar"\nB=\'p@$$w0rd#1\'\nC="a\\"b"\nD=${REF}\nE=plain\n';
		const fromReader = parseEnvFileForForm(content);
		const fromPanel = parseRawContent(content).vars;
		expect(fromReader.map((row) => [row.key, row.value])).toEqual(
			fromPanel.map((row) => [row.key, row.value])
		);
		// And the values are the ones the file means, not its syntax.
		expect(fromReader).toEqual([
			{ key: 'A', value: 'bar' },
			{ key: 'B', value: 'p@$$w0rd#1' },
			{ key: 'C', value: 'a"b' },
			{ key: 'D', value: '${REF}' },
			{ key: 'E', value: 'plain' }
		]);
	});

	test('every caller that fills the form reads through it', () => {
		// Three callers fill the same form, and a unit test cannot invoke an API route or a
		// Svelte component, so this reads their sources. Importing the reader proves
		// nothing - an unused import survives a caller going back to its own loop - so what
		// is checked is that each one CALLS it and that no line in it slices a value out of
		// the text itself.
		const callers = [
			'../src/routes/api/stacks/[name]/env/+server.ts',
			'../src/routes/api/stacks/[name]/relocate/+server.ts',
			'../src/routes/stacks/StackModal.svelte',
			'../src/lib/server/git.ts'
		];
		for (const caller of callers) {
			const source = readFileSync(new URL(caller, import.meta.url), 'utf8');
			// git.ts reads through envFileFormVars, the form reader minus SOPS metadata.
			expect(source).toMatch(/parseEnvFileForForm\(|envFileFormVars\(/);
			// A hand-rolled value split is how the callers drifted apart, whatever it names
			// its locals. git.ts legitimately has one in `parseEnvFileContent`, the
			// DEPLOY-time reader, so that function's body is the one exception.
			const deployReader = source.indexOf('export function parseEnvFileContent');
			const deployReaderEnd = deployReader < 0 ? -1 : source.indexOf('\n}', deployReader);
			const handRolled = [...source.matchAll(/\.(slice|substring)\(\s*\w+\s*\+\s*1\s*\)/g)]
				.filter((hit) => deployReader < 0 || hit.index! < deployReader || hit.index! > deployReaderEnd)
				.map((hit) => source.slice(source.lastIndexOf('\n', hit.index!) + 1, source.indexOf('\n', hit.index!)).trim());
			expect(handRolled).toEqual([]);
		}
	});
});
