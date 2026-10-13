import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { isGitStackOverride } from '../src/lib/env-merge';
import {
	unquote,
	expandValue,
	resolveEnvValues,
	quoteForEnvFile
} from '../src/lib/utils/env-file-values';

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

	test('the editor read and the previews keep the raw text', () => {
		const views = git.match(/parseEnvFileContent\([^)]*expand: false[^)]*\)/g) ?? [];
		expect(views.length).toBe(3);
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

	test('the editor read and the two previews keep the raw text', () => {
		expect((git.match(/parseEnvFileContent\([^)]*expand: false[^)]*\)/g) ?? []).length).toBe(3);
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
