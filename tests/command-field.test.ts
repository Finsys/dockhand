import { describe, test, expect } from 'bun:test';
import { commandPayload, commandTextError, formatCommandArgs, parseCommandText } from '../src/lib/utils/command-field';

// Linkwarden's image CMD: one shell string with quoted arguments to concurrently inside it.
const LINKWARDEN = ['sh', '-c', 'yarn prisma:deploy && yarn concurrently "cd apps/web && yarn start" "cd apps/worker && yarn worker:prod"'];

const CORPUS: string[][] = [
	['sleep', '3600'],
	['nginx', '-g', 'daemon off;'],
	['sh', '-c', 'echo hello world'],
	LINKWARDEN,
	['sh', '-c', "echo 'it works'"],
	['sh', '-c', 'echo "it\'s"'],
	['sh', '-c', 'printf "%s\\n" $HOME `id` \\\\'],
	['a', '', 'b'],
	[''],
	['  leading', 'trailing  '],
	['tab\there', 'new\nline'],
	['sh', '-c', 'echo a\necho b'],
	['sh', '-c', 'line1\r\nline2'],
	['[', 'x', ']'],
	['["a"]'],
	['[]'],
	['{"k": 1}'],
	['--opt="x y"', "--other='z'"],
	['zażółć gęślą', '日本語']
];

describe('formatCommandArgs / parseCommandText', () => {
	test.each(CORPUS.map((c) => [JSON.stringify(c), c]))('%s round-trips exactly', (_label, args) => {
		expect(parseCommandText(formatCommandArgs(args as string[]))).toEqual(args as string[]);
	});

	test('a command plain words carry is shown as plain words, as before', () => {
		expect(formatCommandArgs(['sleep', '3600'])).toBe('sleep 3600');
		expect(formatCommandArgs(['sh', '-c', 'echo hello world'])).toBe('sh -c "echo hello world"');
		expect(formatCommandArgs(['nginx', '-g', 'daemon off;'])).toBe('nginx -g "daemon off;"');
	});

	test('a command plain words would split is shown as a JSON array', () => {
		expect(formatCommandArgs(LINKWARDEN)).toBe(JSON.stringify(LINKWARDEN));
	});

	test('a command with a newline uses the JSON form, which a single-line input keeps', () => {
		// A raw newline cannot survive a single-line <input>, so plain form would drop it.
		const nl = ['sh', '-c', 'echo a\necho b'];
		expect(formatCommandArgs(nl)).toBe(JSON.stringify(nl));
		expect(formatCommandArgs(['sh', '-c', 'a\r\nb'])).toBe(JSON.stringify(['sh', '-c', 'a\r\nb']));
	});

	test('no command is an empty field', () => {
		expect(formatCommandArgs(null)).toBe('');
		expect(formatCommandArgs(undefined)).toBe('');
		expect(formatCommandArgs([])).toBe('');
	});

	test('typed plain words split as before', () => {
		expect(parseCommandText('sleep 3600')).toEqual(['sleep', '3600']);
		expect(parseCommandText('  sh -c "echo hi there" ')).toEqual(['sh', '-c', 'echo hi there']);
		expect(parseCommandText("python -c 'print(1)'")).toEqual(['python', '-c', 'print(1)']);
	});

	test('a typed JSON array of strings is taken as the array', () => {
		expect(parseCommandText('["sh", "-c", "echo \\"a b\\""]')).toEqual(['sh', '-c', 'echo "a b"']);
	});

	test('text that only looks like JSON falls back to plain words', () => {
		expect(parseCommandText('[ -f /x ]')).toEqual(['[', '-f', '/x', ']']);
		expect(parseCommandText('[1, 2]')).toEqual(['[1,', '2]']);
		expect(parseCommandText('["a", 1]')).toEqual(['[a,', '1]']);
	});
});

describe('commandTextError', () => {
	test('a well-formed command, plain or JSON, has no error', () => {
		for (const args of CORPUS) {
			expect(commandTextError(formatCommandArgs(args))).toBeNull();
		}
		expect(commandTextError('')).toBeNull();
		expect(commandTextError('sleep 3600')).toBeNull();
		expect(commandTextError("sh -c 'echo hi'")).toBeNull();
		// A shell `[ ... ]` test is not the JSON form, so it is accepted as plain words.
		expect(commandTextError('[ -f /x ]')).toBeNull();
	});

	test('text in the JSON form that does not parse is rejected, not silently shell-split', () => {
		// A broken edit of a shown JSON array: an inner quote left unescaped.
		expect(commandTextError('["sh", "-c", "echo "a b""]')).not.toBeNull();
		expect(commandTextError('["sh", "-c"')).not.toBeNull();
		expect(commandTextError('["sh", 1]')).not.toBeNull();
	});
});

describe('commandPayload', () => {
	test('an untouched command is left out of the payload, so the server keeps the array', () => {
		for (const args of CORPUS) {
			const shown = formatCommandArgs(args);
			expect(commandPayload(shown, shown)).toBeUndefined();
		}
		expect('cmd' in JSON.parse(JSON.stringify({ cmd: commandPayload('x', 'x') }))).toBe(false);
	});

	test('surrounding whitespace alone is not an edit', () => {
		const shown = formatCommandArgs(LINKWARDEN);
		expect(commandPayload(`  ${shown} `, shown)).toBeUndefined();
	});

	test('a cleared command is null, so the server clears it', () => {
		expect(commandPayload('', 'sleep 3600')).toBeNull();
		expect(commandPayload('   ', 'sleep 3600')).toBeNull();
		expect(commandPayload('[]', 'sleep 3600')).toBeNull();
	});

	test('an edited command is parsed', () => {
		expect(commandPayload('sleep 60', 'sleep 3600')).toEqual(['sleep', '60']);
		expect(commandPayload('sh -c "echo hi there"', '')).toEqual(['sh', '-c', 'echo hi there']);
	});

	test('an edit inside the JSON form keeps every other argument exact', () => {
		const shown = formatCommandArgs(LINKWARDEN);
		const edited = shown.replace('yarn start', 'yarn start:prod');
		expect(commandPayload(edited, shown)).toEqual([LINKWARDEN[0], LINKWARDEN[1], LINKWARDEN[2].replace('yarn start', 'yarn start:prod')]);
	});

	test('a container with no command and an untouched field sends nothing', () => {
		expect(commandPayload('', formatCommandArgs(null))).toBeUndefined();
	});
});
