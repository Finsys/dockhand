import { describe, test, expect } from 'bun:test';
import { openapiSpec } from '../src/lib/server/openapi';

describe('OpenAPI Specification', () => {
	test('spec has valid OpenAPI version', () => {
		expect(openapiSpec.openapi).toBe('3.0.3');
	});

	test('spec has info section', () => {
		expect(openapiSpec.info).toBeDefined();
		expect(openapiSpec.info.title).toBe('Dockhand API');
		expect(openapiSpec.info.version).toBeDefined();
	});

	test('spec has paths defined', () => {
		expect(openapiSpec.paths).toBeDefined();
		expect(Object.keys(openapiSpec.paths).length).toBeGreaterThan(0);
	});

	test('spec includes core endpoints', () => {
		const paths = Object.keys(openapiSpec.paths);
		expect(paths).toContain('/health');
		expect(paths).toContain('/auth/login');
		expect(paths).toContain('/environments');
		expect(paths).toContain('/containers');
	});

	test('spec has security schemes', () => {
		expect(openapiSpec.components?.securitySchemes).toBeDefined();
		expect(openapiSpec.components.securitySchemes.cookieAuth).toBeDefined();
	});

	test('all paths have at least one method', () => {
		for (const [, methods] of Object.entries(openapiSpec.paths)) {
			const httpMethods = Object.keys(methods).filter((m) =>
				['get', 'post', 'put', 'delete', 'patch'].includes(m)
			);
			expect(httpMethods.length).toBeGreaterThan(0);
		}
	});

	test('all operations have responses', () => {
		for (const [, methods] of Object.entries(openapiSpec.paths)) {
			for (const [method, operation] of Object.entries(methods as Record<string, any>)) {
				if (['get', 'post', 'put', 'delete', 'patch'].includes(method)) {
					expect(operation.responses).toBeDefined();
				}
			}
		}
	});
});
