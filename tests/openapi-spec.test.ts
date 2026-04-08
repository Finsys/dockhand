import { describe, test, expect } from 'bun:test';
import { openapiSpec } from '../src/lib/server/openapi';

describe('OpenAPI Specification', () => {
	test('spec has valid OpenAPI version', () => {
		expect(openapiSpec.openapi).toBe('3.0.3');
	});

	test('spec has complete info section', () => {
		expect(openapiSpec.info).toBeDefined();
		expect(openapiSpec.info.title).toBe('Dockhand API');
		expect(openapiSpec.info.version).toBeDefined();
		expect(openapiSpec.info.description).toBeDefined();
	});

	test('spec documents 100+ endpoints', () => {
		const pathCount = Object.keys(openapiSpec.paths).length;
		expect(pathCount).toBeGreaterThanOrEqual(100);
	});

	test('spec covers all core endpoint groups', () => {
		const paths = Object.keys(openapiSpec.paths);

		// Health
		expect(paths).toContain('/health');
		expect(paths).toContain('/health/database');

		// Auth
		expect(paths).toContain('/auth/login');
		expect(paths).toContain('/auth/session');
		expect(paths).toContain('/auth/logout');

		// Environments
		expect(paths).toContain('/environments');
		expect(paths).toContain('/environments/{id}');

		// Hawser Tokens
		expect(paths).toContain('/hawser/tokens');

		// Containers
		expect(paths).toContain('/containers');
		expect(paths).toContain('/containers/{id}');
		expect(paths).toContain('/containers/{id}/start');
		expect(paths).toContain('/containers/{id}/stop');
		expect(paths).toContain('/containers/{id}/logs');

		// Stacks
		expect(paths).toContain('/stacks');
		expect(paths).toContain('/stacks/{name}');
		expect(paths).toContain('/stacks/{name}/compose');

		// Images
		expect(paths).toContain('/images');
		expect(paths).toContain('/images/pull');

		// Networks & Volumes
		expect(paths).toContain('/networks');
		expect(paths).toContain('/volumes');

		// Git
		expect(paths).toContain('/git/stacks');
		expect(paths).toContain('/git/credentials');

		// System
		expect(paths).toContain('/system');
		expect(paths).toContain('/settings/general');

		// Users & Roles
		expect(paths).toContain('/users');
		expect(paths).toContain('/roles');

		// Notifications & Schedules
		expect(paths).toContain('/notifications');
		expect(paths).toContain('/schedules');

		// Activity & Audit
		expect(paths).toContain('/activity');
		expect(paths).toContain('/audit');
	});

	test('spec has security schemes', () => {
		expect(openapiSpec.components?.securitySchemes).toBeDefined();
		expect(openapiSpec.components.securitySchemes.cookieAuth).toBeDefined();
		expect(openapiSpec.components.securitySchemes.cookieAuth.name).toBe('dockhand_session');
	});

	test('spec has reusable component schemas', () => {
		const schemas = Object.keys(openapiSpec.components?.schemas || {});
		expect(schemas.length).toBeGreaterThanOrEqual(10);
		expect(schemas).toContain('Environment');
		expect(schemas).toContain('Container');
	});

	test('all paths have at least one HTTP method', () => {
		for (const [path, methods] of Object.entries(openapiSpec.paths)) {
			const httpMethods = Object.keys(methods).filter((m) =>
				['get', 'post', 'put', 'delete', 'patch'].includes(m)
			);
			expect(httpMethods.length).toBeGreaterThan(0);
		}
	});

	test('all operations have responses defined', () => {
		for (const [, methods] of Object.entries(openapiSpec.paths)) {
			for (const [method, operation] of Object.entries(methods as Record<string, any>)) {
				if (['get', 'post', 'put', 'delete', 'patch'].includes(method)) {
					expect(operation.responses).toBeDefined();
				}
			}
		}
	});

	test('all operations have tags', () => {
		for (const [path, methods] of Object.entries(openapiSpec.paths)) {
			for (const [method, operation] of Object.entries(methods as Record<string, any>)) {
				if (['get', 'post', 'put', 'delete', 'patch'].includes(method)) {
					expect(operation.tags).toBeDefined();
					expect(operation.tags.length).toBeGreaterThan(0);
				}
			}
		}
	});

	test('all operations have summary', () => {
		for (const [path, methods] of Object.entries(openapiSpec.paths)) {
			for (const [method, operation] of Object.entries(methods as Record<string, any>)) {
				if (['get', 'post', 'put', 'delete', 'patch'].includes(method)) {
					expect(operation.summary).toBeDefined();
					expect(operation.summary.length).toBeGreaterThan(0);
				}
			}
		}
	});
});
