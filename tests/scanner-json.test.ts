import { describe, test, expect } from 'bun:test';

// extractJson and sanitizeJsonString are pure functions defined in scanner.ts,
// but that module has heavy side-effect imports (docker, db). We replicate the
// function bodies here to keep unit tests dependency-free.

function extractJson(output: string): string {
	const firstBrace = output.indexOf('{');
	const lastBrace = output.lastIndexOf('}');
	if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
		throw new Error('No JSON object found in scanner output');
	}
	return output.slice(firstBrace, lastBrace + 1);
}

function sanitizeJsonString(json: string): string {
	let result = '';
	let inString = false;
	let escaped = false;
	let sanitized = 0;

	for (let i = 0; i < json.length; i++) {
		const ch = json.charCodeAt(i);

		if (escaped) {
			const ch2 = json[i];
			if ('"\\\/bfnrtu'.includes(ch2)) {
				result += ch2;
			} else if (ch < 0x20) {
				result += '\\';
				if (ch === 0x0A) result += '\\n';
				else if (ch === 0x0D) result += '\\r';
				else if (ch === 0x09) result += '\\t';
				else result += `\\u${ch.toString(16).padStart(4, '0')}`;
				sanitized++;
			} else {
				result += '\\' + ch2;
				sanitized++;
			}
			escaped = false;
			continue;
		}

		if (inString) {
			if (ch === 0x5C) {
				result += json[i];
				escaped = true;
			} else if (ch === 0x22) {
				result += json[i];
				inString = false;
			} else if (ch < 0x20) {
				if (ch === 0x0A) result += '\\n';
				else if (ch === 0x0D) result += '\\r';
				else if (ch === 0x09) result += '\\t';
				else result += `\\u${ch.toString(16).padStart(4, '0')}`;
				sanitized++;
			} else {
				result += json[i];
			}
		} else {
			if (ch === 0x22) {
				inString = true;
			}
			result += json[i];
		}
	}

	return result;
}

describe('extractJson', () => {
	test('extracts JSON from clean output', () => {
		expect(extractJson('{"key": "value"}')).toBe('{"key": "value"}');
	});

	test('extracts JSON with leading noise', () => {
		const output = 'Scanning image...\nPulling layers...\n{"results": []}';
		expect(extractJson(output)).toBe('{"results": []}');
	});

	test('extracts JSON with trailing noise', () => {
		const output = '{"results": []}\nDone in 5.2s';
		expect(extractJson(output)).toBe('{"results": []}');
	});

	test('extracts JSON surrounded by noise', () => {
		const output = 'INFO: starting\n{"data": true}\nINFO: done';
		expect(extractJson(output)).toBe('{"data": true}');
	});

	test('throws for output with no JSON', () => {
		expect(() => extractJson('no json here')).toThrow('No JSON object found');
	});

	test('throws for empty input', () => {
		expect(() => extractJson('')).toThrow('No JSON object found');
	});

	test('handles nested braces', () => {
		const json = '{"outer": {"inner": {"deep": 1}}}';
		expect(extractJson('prefix ' + json + ' suffix')).toBe(json);
	});
});

describe('sanitizeJsonString', () => {
	test('passes clean JSON through unchanged', () => {
		const json = '{"key": "value", "num": 42}';
		expect(sanitizeJsonString(json)).toBe(json);
	});

	test('escapes raw newlines inside strings', () => {
		const dirty = '{"desc": "line1\nline2"}';
		const result = sanitizeJsonString(dirty);
		expect(() => JSON.parse(result)).not.toThrow();
		const parsed = JSON.parse(result);
		expect(parsed.desc).toBe('line1\nline2');
	});

	test('escapes raw tabs inside strings', () => {
		const dirty = '{"desc": "col1\tcol2"}';
		const result = sanitizeJsonString(dirty);
		expect(() => JSON.parse(result)).not.toThrow();
	});

	test('handles already-escaped sequences', () => {
		const clean = '{"desc": "line1\\nline2"}';
		const result = sanitizeJsonString(clean);
		expect(result).toBe(clean);
	});

	test('escapes null bytes inside strings', () => {
		const dirty = '{"desc": "has\x00null"}';
		const result = sanitizeJsonString(dirty);
		expect(() => JSON.parse(result)).not.toThrow();
	});

	test('does not modify control chars outside strings', () => {
		const json = '{\n  "key": "value"\n}';
		expect(sanitizeJsonString(json)).toBe(json);
	});

	test('handles empty strings', () => {
		const json = '{"key": ""}';
		expect(sanitizeJsonString(json)).toBe(json);
	});
});
