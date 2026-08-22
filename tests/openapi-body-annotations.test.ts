// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import { parseAnnotations, parseMiniSchema } from '../scripts/openapi/lib';
import { buildSpec } from '../scripts/openapi/build-spec';

// Wrap a single-method annotation block in a minimal +server.ts source.
function src(method: string, block: string): string {
	return `/**\n${block}\n */\nexport const ${method}: RequestHandler = async () => new Response();\n`;
}

describe('parseMiniSchema: always terminates + bracket arrays', () => {
	// A mini-schema string with the [T] bracket-array form (or any unrecognized
	// char) must ALWAYS advance the parser cursor. A stuck cursor spun the drift
	// gate for hours in CI. These strings are the ones that hung.
	test('[string] parses as an array of string', () => {
		expect(parseMiniSchema('[string]')).toEqual({ kind: 'array', items: { kind: 'string' } });
	});

	test('nested object with a [T] property (the exact string that hung CI)', () => {
		const s = parseMiniSchema('{compose:string!, config:{disabled:[string], severity:object}}');
		expect(s.kind).toBe('object');
		expect((s as any).properties.config.properties.disabled).toEqual({ kind: 'array', items: { kind: 'string' } });
		expect((s as any).required).toContain('compose');
	});

	test('[{...}]! required array of objects', () => {
		const s = parseMiniSchema('{findings:[{ruleId:string!}]!}');
		expect((s as any).properties.findings.kind).toBe('array');
		expect((s as any).properties.findings.items.kind).toBe('object');
		expect((s as any).required).toContain('findings');
	});

	test('garbage / stray brackets terminate (never infinite-loop)', () => {
		// If any of these looped, the test process would hang instead of asserting.
		expect(() => parseMiniSchema('{a:[[[')).not.toThrow();
		expect(() => parseMiniSchema('[[[[[[')).not.toThrow();
		expect(() => parseMiniSchema('{:::,,,}')).not.toThrow();
		expect(() => parseMiniSchema('@#$%^&*')).not.toThrow();
	});

	test('array<T> long form still works (no regression)', () => {
		expect(parseMiniSchema('array<string>')).toEqual({ kind: 'array', items: { kind: 'string' } });
	});
});

describe('parseAnnotations: non-JSON request bodies', () => {
	test('body-raw parses media type + description', () => {
		const a = parseAnnotations(
			src('POST', ' * @openapi\n * summary: Load an image\n * body-raw: application/x-tar The raw image tar')
		);
		expect(a.POST?.bodyRaw).toEqual({ mediaType: 'application/x-tar', description: 'The raw image tar' });
	});

	test('body-multipart parses field/type/array/required/description', () => {
		const a = parseAnnotations(
			src('POST', ' * @openapi\n * summary: Upload files\n * body-multipart: files:binary[]! One or more files')
		);
		expect(a.POST?.bodyMultipart).toEqual({
			field: 'files',
			type: 'binary',
			array: true,
			required: true,
			description: 'One or more files'
		});
	});

	test('a JSON body: still parses as before (no regression)', () => {
		const a = parseAnnotations(src('POST', ' * @openapi\n * summary: X\n * body: {name:string!}'));
		expect(a.POST?.body).toBeDefined();
		expect(a.POST?.bodyRaw).toBeUndefined();
		expect(a.POST?.bodyMultipart).toBeUndefined();
	});
});

describe('buildSpec: emits requestBody for non-JSON bodies', () => {
	function specFor(filePath: string, openapiPath: string, method: string, block: string) {
		const content = src(method, block);
		const fileContents = new Map([[filePath, content]]);
		const annotationsByPath = { [openapiPath]: parseAnnotations(content) };
		const pathParams = [...openapiPath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
		const routes = [{ filePath, openapiPath, pathParams, tag: 'Test', methods: [method] as any }];
		return buildSpec({
			routes: routes as any,
			fileContents,
			annotationsByPath: annotationsByPath as any,
			isPublicFn: () => true,
			version: 'test'
		}).spec;
	}

	test('body-raw -> application/x-tar content, required', () => {
		const spec = specFor(
			'/x/+server.ts',
			'/api/images/load',
			'POST',
			' * @openapi\n * summary: Load\n * body-raw: application/x-tar The raw image tar'
		);
		const rb: any = spec.paths['/api/images/load'].post.requestBody;
		expect(rb.required).toBe(true);
		expect(rb.content['application/x-tar']).toBeDefined();
		expect(rb.content['application/x-tar'].schema.type).toBe('string');
		expect(rb.content['application/x-tar'].schema.format).toBe('binary');
	});

	test('body-multipart -> multipart/form-data with an array file field, required', () => {
		const spec = specFor(
			'/y/+server.ts',
			'/api/containers/{id}/files/upload',
			'POST',
			' * @openapi\n * summary: Upload\n * body-multipart: files:binary[]! One or more files'
		);
		const rb: any = spec.paths['/api/containers/{id}/files/upload'].post.requestBody;
		expect(rb.required).toBe(true);
		const mp = rb.content['multipart/form-data'];
		expect(mp).toBeDefined();
		expect(mp.schema.type).toBe('object');
		expect(mp.schema.properties.files.type).toBe('array');
		expect(mp.schema.properties.files.items.format).toBe('binary');
		expect(mp.schema.required).toEqual(['files']);
	});
});
