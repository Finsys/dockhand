/**
 * Every API route must be either intentionally public (listed in public-paths-core.ts,
 * the same allow-list the hook enforces) or carry an authorization gate. A route that is
 * neither is reachable with no authorization at all - the missing-check class behind
 * several past advisories. This fails the build when a new +server.ts handler ships
 * without a gate, so the auth decision has to be made in code and reviewed, not forgotten.
 *
 * Static by design: it parses the handler source via the same route discovery the OpenAPI
 * generator uses (no running server/DB), so it runs in the fast unit tier and enumerates
 * the COMPLETE route set. It proves a gate EXISTS; it does not prove the gate is the
 * RIGHT one (view vs edit) - that needs a dynamic role matrix, deliberately out of scope.
 *
 * The check is PER-METHOD: each handler's own body (plus the module-scope prelude, where
 * shared helpers and guards live) is scanned, so a file whose POST is gated cannot vouch
 * for an ungated GET in the same file. Comments are stripped before scanning so a gate
 * named only in a comment or @openapi block does not count.
 *
 * Caveat on two of the recognized signals: `.isAuthenticated` and `auth.user` mean the
 * handler is auth-AWARE (it reads the identity, typically to partition per-user data),
 * NOT that it refuses an unauthenticated caller. They pass the coverage check, but a
 * reviewer must still confirm the self-scoping is real for a route that matches ONLY on
 * one of those two.
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { discoverRoutes, splitMethodBodies } from '../scripts/openapi/lib';
import { isPublicPath } from '../src/lib/server/public-paths-core';

const ROUTES_ROOT = join(process.cwd(), 'src', 'routes');

// A handler is gated when its source uses ANY recognized authorization mechanism. A bare
// `authorize(` call is NOT enough on its own - a handler can resolve the context and
// ignore it - so we look for an actual USE of the context or one of the wrapper guards.
// Keep this list in sync when a new legitimate auth wrapper is added (one reviewed line).
const RECOGNIZED_GATES: string[] = [
	// uses of the authorize() context (src/lib/server/authorize.ts)
	'.can(',
	'.canManageUsers(',
	'.canManageSettings(',
	'.canViewAuditLog(',
	'.requirePermission(',
	'.requireEnvAccess(',
	'.canAccessEnvironment(',
	'.isAdmin',
	'.isAuthenticated',
	// catalog wrappers
	'authorizeVulnAccess(', // src/lib/server/vuln-access.ts
	'requireBackups(', // src/lib/server/backups/route-guards.ts
	'loadConfigGateEnv(', // src/lib/server/backups/route-guards.ts
	'canAccessJob(', // src/lib/server/jobs.ts
	'verifyWebhookSignature(', // src/lib/server/webhook-signature.ts
	'timingSafeStringEqual(', // src/lib/server/webhook-signature.ts
	'validateSession(', // src/lib/server/auth.ts - paired with a manual owner/admin check
	'authenticateWsUpgrade(', // src/lib/server/ws-auth.ts
	// signed-in self-scoped: the handler partitions data per-user by the authorize()
	// context's identity (per-user preferences etc.) - auth-aware, scoped by user id, not
	// a flat permission. Equivalent to Dockmesh's "gateSignedIn" category.
	'auth.user',
	// permission gate enforced in an injected/import-light core that returns a
	// 'permission-denied' outcome the thin route maps to 403 (e.g. git/preview-env ->
	// preview-env-handler.ts applies git:edit). The core file is unit-tested separately.
	"'permission-denied'"
];

// Routes that are public-by-code but NOT yet in public-paths-core.ts, so the hook would
// 401 them when auth is on - a real inconsistency to resolve (add to the allow-list if
// public, or add a gate if not). Listed here so the suite is green while the decision is
// pending; REMOVE an entry once the route is either allow-listed or gated. A stale entry
// (route now gated/public/gone) fails the staleness test below, so this can't rot.
const PENDING_INCONSISTENCIES = new Set<string>([]);

function concretePath(openapiPath: string): string {
	// Replace {param} with a literal so isPublicPath's exact/prefix/regex checks apply
	// (the webhook regexes expect a numeric id, and 1 satisfies \d+).
	return openapiPath.replace(/\{[^}]+\}/g, '1');
}

// Strip line and block comments so a gate named only in a comment or an @openapi block
// (which is a block comment) does not count as a real gate. Leaves string literals alone
// - good enough, since a gate string living inside a quoted string is not a concern here.
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function hasGate(source: string): boolean {
	const code = stripComments(source);
	return RECOGNIZED_GATES.some((g) => code.includes(g));
}

const { routes, fileContents } = discoverRoutes([ROUTES_ROOT], ROUTES_ROOT);

// Metrics-public matches the generator's view of the auth model (/metrics is public only
// when EXPORT_METRICS_PUBLIC is set; treat it as reachable-public here so the route isn't
// demanded to carry a handler gate it legitimately may not).
const METRICS_PUBLIC = true;

// The module prelude: everything before the first `export const <METHOD>:`. Shared
// helpers/guards defined there (e.g. an ownerId() that reads auth.user) are in scope for
// every handler, so they count toward each method's gate.
function modulePrelude(source: string): string {
	const m = /^export const (GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s*:/m.exec(source);
	return m ? source.slice(0, m.index) : source;
}

/** Ungated, non-public routes keyed "METHOD /path" -> their handler file. Per-method:
 *  each handler body is scanned together with the module prelude, so one gated method in
 *  a file does not vouch for an ungated sibling. */
function findUngated(): Map<string, string> {
	const ungated = new Map<string, string>();
	for (const r of routes) {
		if (isPublicPath(concretePath(r.openapiPath), METRICS_PUBLIC)) continue;
		const source = fileContents.get(r.filePath) ?? '';
		const prelude = modulePrelude(source);
		const bodies = splitMethodBodies(source);
		for (const method of r.methods) {
			const body = bodies[method] ?? '';
			if (hasGate(prelude + '\n' + body)) continue;
			ungated.set(`${method} ${r.openapiPath}`, r.filePath);
		}
	}
	return ungated;
}

describe('route authorization-gate coverage', () => {
	test('every non-public API route carries a recognized authorization gate', () => {
		const ungated = findUngated();
		const offenders = [...ungated.keys()]
			.filter((k) => !PENDING_INCONSISTENCIES.has(k))
			.sort();

		if (offenders.length > 0) {
			const lines = offenders.map((k) => `  ${k}  (${ungated.get(k)})`).join('\n');
			throw new Error(
				`${offenders.length} API route(s) have no authorization gate:\n${lines}\n\n` +
					`Add an authorization gate to the handler, or - if the route is intentionally ` +
					`public - add it to PUBLIC_EXACT / PUBLIC_PREFIXES in ` +
					`src/lib/server/public-paths-core.ts. If it uses a NEW auth wrapper, add that ` +
					`wrapper to RECOGNIZED_GATES in this test.`
			);
		}
		expect(offenders).toEqual([]);
	});

	test('every PENDING_INCONSISTENCIES entry still matches an ungated route (no rot)', () => {
		const ungated = findUngated();
		const stale = [...PENDING_INCONSISTENCIES].filter((k) => !ungated.has(k)).sort();
		if (stale.length > 0) {
			throw new Error(
				`PENDING_INCONSISTENCIES has ${stale.length} stale entr(y/ies) - the route is now ` +
					`gated, public, or gone. Remove it from the set:\n  ${stale.join('\n  ')}`
			);
		}
		expect(stale).toEqual([]);
	});
});
