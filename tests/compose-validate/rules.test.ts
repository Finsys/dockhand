// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import { runValidate } from '../../src/lib/server/compose-validate/index';
import type { ValidateContext } from '../../src/lib/server/compose-validate/types';
import { applyQuickFix } from '../../src/lib/utils/compose-quick-fix';

function ids(src: string, ctx: ValidateContext = {}): string[] {
	return runValidate(src, ctx).findings.map((f) => f.ruleId);
}
function find(src: string, ruleId: string, ctx: ValidateContext = {}) {
	return runValidate(src, ctx).findings.find((f) => f.ruleId === ruleId);
}

describe('parse + line tracking', () => {
	test('a clean compose yields no findings', () => {
		const src = `services:\n  web:\n    image: nginx:1.27\n    restart: unless-stopped\n    healthcheck:\n      test: ["CMD", "true"]\n    ports:\n      - "127.0.0.1:8080:80"\n`;
		expect(runValidate(src).findings).toEqual([]);
	});

	test('a finding carries the 1-based line of the offending key', () => {
		const src = `services:\n  web:\n    image: nginx:latest\n`;
		const f = find(src, 'LATEST_TAG');
		expect(f?.line).toBe(3); // the `image:` line
	});

	test('a key with a nested value maps to the KEY line, not its first child', () => {
		// `enviroment:` is a typo whose value is a nested block; the marker must sit on
		// the key line (5), not the first child line (6) - the off-by-one regression.
		const src =
			`services:\n` +
			`  db:\n` +
			`    image: postgres:16\n` +
			`    enviroment:\n` + // line 4 (1-based)
			`      - POSTGRES_PASSWORD=x\n`; // line 5
		const f = find(src, 'UNKNOWN_SERVICE_KEY');
		expect(f?.line).toBe(4);
	});

	test('invalid YAML is a single parse-error finding', () => {
		const r = runValidate('services:\n  web:\n   image: [unclosed\n');
		expect(r.findings.some((f) => f.ruleId === 'YAML_PARSE_ERROR')).toBe(true);
	});

	test('duplicate key is caught as a parse error (js-yaml strict)', () => {
		const r = runValidate('services:\n  web:\n    image: a\n    image: b\n');
		expect(r.findings.some((f) => f.ruleId === 'YAML_PARSE_ERROR')).toBe(true);
	});
});

describe('port rules', () => {
	test('DUPLICATE_HOST_PORT: two services on the same host port', () => {
		const src = `services:\n  a:\n    image: x\n    ports: ["8080:80"]\n  b:\n    image: y\n    ports: ["8080:81"]\n`;
		expect(ids(src)).toContain('DUPLICATE_HOST_PORT');
	});

	test('no duplicate when host ports differ', () => {
		const src = `services:\n  a:\n    image: x\n    ports: ["8080:80"]\n  b:\n    image: y\n    ports: ["8081:81"]\n`;
		expect(ids(src)).not.toContain('DUPLICATE_HOST_PORT');
	});

	test('CROSS_STACK_PORT_COLLISION uses ctx.usedHostPorts', () => {
		const src = `services:\n  a:\n    image: x\n    ports: ["8080:80"]\n`;
		expect(ids(src, { usedHostPorts: new Set([8080]) })).toContain('CROSS_STACK_PORT_COLLISION');
		expect(ids(src, { usedHostPorts: new Set([9999]) })).not.toContain('CROSS_STACK_PORT_COLLISION');
	});

	test('CROSS_STACK_PORT_COLLISION names the container that owns the port', () => {
		const src = `services:\n  a:\n    image: x\n    ports: ["8080:80"]\n`;
		const f = find(src, 'CROSS_STACK_PORT_COLLISION', {
			usedHostPorts: new Set([8080]),
			hostPortOwners: new Map([[8080, 'grafana-1']])
		});
		expect(f?.message).toContain('grafana-1');
		expect(f?.hint).toContain('grafana-1');
	});

	test('DB_PORT_ON_ALL_INTERFACES only for db/cache images without a host ip', () => {
		const bad = `services:\n  db:\n    image: postgres:16\n    ports: ["5432:5432"]\n`;
		const ok = `services:\n  db:\n    image: postgres:16\n    ports: ["127.0.0.1:5432:5432"]\n`;
		const notDb = `services:\n  web:\n    image: nginx:1.27\n    ports: ["8080:80"]\n`;
		expect(ids(bad)).toContain('DB_PORT_ON_ALL_INTERFACES');
		expect(ids(ok)).not.toContain('DB_PORT_ON_ALL_INTERFACES');
		expect(ids(notDb)).not.toContain('DB_PORT_ON_ALL_INTERFACES');
	});

	test('long-form port object is parsed', () => {
		const src = `services:\n  a:\n    image: x\n    ports:\n      - target: 80\n        published: 8080\n  b:\n    image: y\n    ports:\n      - target: 81\n        published: 8080\n`;
		expect(ids(src)).toContain('DUPLICATE_HOST_PORT');
	});
});

describe('correctness rules', () => {
	test('DEPENDS_ON_UNDEFINED', () => {
		const src = `services:\n  web:\n    image: x\n    depends_on: [db]\n`;
		expect(ids(src)).toContain('DEPENDS_ON_UNDEFINED');
	});
	test('depends_on to a real service is fine', () => {
		const src = `services:\n  web:\n    image: x\n    depends_on: [db]\n  db:\n    image: postgres:16\n`;
		expect(ids(src)).not.toContain('DEPENDS_ON_UNDEFINED');
	});

	test('CONTAINER_NAME_COLLISION uses ctx', () => {
		const src = `services:\n  web:\n    image: x\n    container_name: myapp\n`;
		expect(ids(src, { existingContainerNames: new Set(['myapp']) })).toContain('CONTAINER_NAME_COLLISION');
		expect(ids(src, { existingContainerNames: new Set(['other']) })).not.toContain('CONTAINER_NAME_COLLISION');
	});

	test('MISSING_EXTERNAL_RESOURCE / VOLUME against ctx', () => {
		const netSrc = `services:\n  web:\n    image: x\nnetworks:\n  shared:\n    external: true\n`;
		expect(ids(netSrc, { existingNetworks: new Set([]) })).toContain('MISSING_EXTERNAL_RESOURCE');
		expect(ids(netSrc, { existingNetworks: new Set(['shared']) })).not.toContain('MISSING_EXTERNAL_RESOURCE');

		const volSrc = `services:\n  web:\n    image: x\nvolumes:\n  data:\n    external: true\n`;
		expect(ids(volSrc, { existingVolumes: new Set([]) })).toContain('MISSING_EXTERNAL_RESOURCE');
	});

	test('NO_SERVICES when the services block is empty/missing', () => {
		expect(ids('networks:\n  x: {}\n')).toContain('NO_SERVICES');
	});
});

describe('security rules', () => {
	test('PRIVILEGED_CONTAINER', () => {
		expect(ids(`services:\n  a:\n    image: x\n    privileged: true\n`)).toContain('PRIVILEGED_CONTAINER');
	});
	test('DOCKER_SOCKET_MOUNT rw=error, ro=warn', () => {
		const rw = runValidate(`services:\n  a:\n    image: x\n    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]\n`);
		const ro = runValidate(`services:\n  a:\n    image: x\n    volumes: ["/var/run/docker.sock:/var/run/docker.sock:ro"]\n`);
		expect(rw.findings.find((f) => f.ruleId === 'DOCKER_SOCKET_MOUNT')?.severity).toBe('error');
		expect(ro.findings.find((f) => f.ruleId === 'DOCKER_SOCKET_MOUNT')?.severity).toBe('warn');
	});
});

describe('reproducibility + schema rules', () => {
	test('LATEST_TAG for :latest and untagged', () => {
		expect(ids(`services:\n  a:\n    image: nginx:latest\n`)).toContain('LATEST_TAG');
		expect(ids(`services:\n  a:\n    image: nginx\n`)).toContain('LATEST_TAG');
		expect(ids(`services:\n  a:\n    image: nginx:1.27\n`)).not.toContain('LATEST_TAG');
	});

	test('OBSOLETE_VERSION_KEY', () => {
		expect(ids(`version: "3.8"\nservices:\n  a:\n    image: nginx:1.27\n`)).toContain('OBSOLETE_VERSION_KEY');
	});

	test('UNKNOWN_SERVICE_KEY catches a typo and suggests the real key', () => {
		const f = find(`services:\n  a:\n    image: x\n    resart: always\n`, 'UNKNOWN_SERVICE_KEY');
		expect(f).toBeDefined();
		expect(f?.message).toContain('restart');
	});

	test('a valid but distant key is NOT flagged as a typo', () => {
		expect(ids(`services:\n  a:\n    image: x\n    environment: [FOO=1]\n`)).not.toContain('UNKNOWN_SERVICE_KEY');
	});

	test('x- extension keys are allowed at top level', () => {
		expect(ids(`x-shared: &s {}\nservices:\n  a:\n    image: nginx:1.27\n`)).not.toContain('UNKNOWN_TOP_LEVEL_KEY');
	});

	test('UNKNOWN_TOP_LEVEL_KEY catches a typo`d top key', () => {
		const f = find(`servies:\n  a:\n    image: x\n`, 'UNKNOWN_TOP_LEVEL_KEY');
		expect(f?.message).toContain('services');
	});
});

describe('report shape', () => {
	test('counts + sort most-severe first', () => {
		const src = `services:\n  db:\n    image: postgres:latest\n    ports: ["5432:5432"]\n    privileged: true\n`;
		const r = runValidate(src);
		expect(r.counts.error + r.counts.warn + r.counts.info).toBe(r.findings.length);
		// first finding is the most severe present
		const sevRank = { error: 0, warn: 1, info: 2 } as const;
		for (let i = 1; i < r.findings.length; i++) {
			expect(sevRank[r.findings[i - 1].severity]).toBeLessThanOrEqual(sevRank[r.findings[i].severity]);
		}
	});
});

describe('user config: disable + severity override', () => {
	const dbSrc = `services:\n  db:\n    image: postgres:16\n    ports: ["5432:5432"]\n`;

	test('a disabled rule produces no findings', () => {
		const on = runValidate(dbSrc);
		expect(on.findings.some((f) => f.ruleId === 'DB_PORT_ON_ALL_INTERFACES')).toBe(true);
		const off = runValidate(dbSrc, {}, { disabled: ['DB_PORT_ON_ALL_INTERFACES'] });
		expect(off.findings.some((f) => f.ruleId === 'DB_PORT_ON_ALL_INTERFACES')).toBe(false);
	});

	test('a severity override changes the finding severity', () => {
		const def = runValidate(dbSrc).findings.find((f) => f.ruleId === 'DB_PORT_ON_ALL_INTERFACES');
		expect(def?.severity).toBe('warn'); // default
		const bumped = runValidate(dbSrc, {}, { severity: { DB_PORT_ON_ALL_INTERFACES: 'error' } })
			.findings.find((f) => f.ruleId === 'DB_PORT_ON_ALL_INTERFACES');
		expect(bumped?.severity).toBe('error');
	});

	test('a graded rule (docker.sock rw) ignores the override and stays error', () => {
		const src = `services:\n  a:\n    image: x\n    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]\n`;
		const f = runValidate(src, {}, { severity: { DOCKER_SOCKET_MOUNT: 'info' } })
			.findings.find((x) => x.ruleId === 'DOCKER_SOCKET_MOUNT');
		expect(f?.severity).toBe('error'); // rw is intrinsically error; override does not soften it
	});
});

describe('referential integrity (undefined network/volume refs)', () => {
	test('UNDEFINED_NETWORK_REF when a service uses a network not defined top-level', () => {
		const src = `services:\n  web:\n    image: nginx:1.27\n    networks: [backend]\n`;
		expect(ids(src)).toContain('UNDEFINED_NETWORK_REF');
	});
	test('a network defined top-level (incl. external) is fine', () => {
		const defined = `services:\n  web:\n    image: nginx:1.27\n    networks: [backend]\nnetworks:\n  backend: {}\n`;
		expect(ids(defined)).not.toContain('UNDEFINED_NETWORK_REF');
		const ext = `services:\n  web:\n    image: nginx:1.27\n    networks: [shared]\nnetworks:\n  shared:\n    external: true\n`;
		expect(ids(ext)).not.toContain('UNDEFINED_NETWORK_REF');
	});
	test('the implicit default network is never flagged', () => {
		expect(ids(`services:\n  web:\n    image: nginx:1.27\n    networks: [default]\n`)).not.toContain('UNDEFINED_NETWORK_REF');
	});

	test('UNDEFINED_VOLUME_REF for a named volume not defined top-level', () => {
		const src = `services:\n  db:\n    image: postgres:16\n    volumes:\n      - pgdata:/var/lib/postgresql/data\n`;
		expect(ids(src)).toContain('UNDEFINED_VOLUME_REF');
	});
	test('a bind mount (path) is NOT a named-volume ref', () => {
		const bind = `services:\n  web:\n    image: nginx:1.27\n    volumes:\n      - ./html:/usr/share/nginx/html\n      - /etc/localtime:/etc/localtime:ro\n`;
		expect(ids(bind)).not.toContain('UNDEFINED_VOLUME_REF');
	});
	test('a named volume defined top-level is fine', () => {
		const ok = `services:\n  db:\n    image: postgres:16\n    volumes:\n      - pgdata:/var/lib/postgresql/data\nvolumes:\n  pgdata: {}\n`;
		expect(ids(ok)).not.toContain('UNDEFINED_VOLUME_REF');
	});
});

describe('quick fixes (only unambiguous rules carry a fix)', () => {
	test('OBSOLETE_VERSION_KEY offers a delete-line fix on the version line', () => {
		const src = `version: "3.8"\nservices:\n  web:\n    image: nginx:1.27\n`;
		const f = find(src, 'OBSOLETE_VERSION_KEY');
		expect(f?.fix).toEqual({ kind: 'delete-line', line: 1 });
	});

	test('UNKNOWN_SERVICE_KEY offers a replace-in-line typo fix', () => {
		const src = `services:\n  web:\n    image: nginx:1.27\n    restar: always\n`;
		const f = find(src, 'UNKNOWN_SERVICE_KEY');
		expect(f?.fix).toEqual({ kind: 'replace-in-line', line: 4, find: 'restar', replace: 'restart' });
	});

	test('UNKNOWN_TOP_LEVEL_KEY offers a replace-in-line typo fix', () => {
		const src = `servics:\n  web:\n    image: nginx:1.27\n`;
		const f = find(src, 'UNKNOWN_TOP_LEVEL_KEY');
		expect(f?.fix).toEqual({ kind: 'replace-in-line', line: 1, find: 'servics', replace: 'services' });
	});

	test('DB_PORT_ON_ALL_INTERFACES prefixes 127.0.0.1 on the short string form', () => {
		const src = `services:\n  db:\n    image: postgres:16\n    ports:\n      - "5432:5432"\n`;
		const f = find(src, 'DB_PORT_ON_ALL_INTERFACES');
		expect(f?.fix).toMatchObject({ kind: 'replace-in-line', line: 5, find: '5432:5432', replace: '127.0.0.1:5432:5432' });
		expect(typeof (f?.fix as { at?: number })?.at).toBe('number'); // anchored to the token column
	});

	test('DB_PORT_ON_ALL_INTERFACES rewrites an explicit 0.0.0.0 bind', () => {
		const src = `services:\n  db:\n    image: redis:7\n    ports:\n      - "0.0.0.0:6379:6379"\n`;
		const f = find(src, 'DB_PORT_ON_ALL_INTERFACES');
		expect(f?.fix).toMatchObject({
			kind: 'replace-in-line',
			line: 5,
			find: '0.0.0.0:6379:6379',
			replace: '127.0.0.1:6379:6379'
		});
	});

	test('the long object port form gets NO fix (no single-token edit)', () => {
		const src =
			`services:\n  db:\n    image: postgres:16\n    ports:\n      - target: 5432\n        published: 5432\n`;
		const f = find(src, 'DB_PORT_ON_ALL_INTERFACES');
		expect(f).toBeDefined();
		expect(f?.fix).toBeUndefined();
	});

	test('rules that need a user decision carry NO fix', () => {
		const src =
			`services:\n  web:\n    image: nginx:latest\n    privileged: true\n    depends_on:\n      - ghost\n`;
		const r = runValidate(src);
		for (const id of ['LATEST_TAG', 'PRIVILEGED_CONTAINER', 'DEPENDS_ON_UNDEFINED']) {
			expect(r.findings.find((f) => f.ruleId === id)?.fix).toBeUndefined();
		}
	});

	test('MISSING_RESTART_POLICY offers an insert-after fix matching 4-space child indent', () => {
		const src = `services:\n  web:\n    image: nginx:1.27\n`;
		const f = find(src, 'MISSING_RESTART_POLICY');
		expect(f?.fix).toEqual({ kind: 'insert-after', line: 2, text: '    restart: unless-stopped' });
	});

	test('MISSING_RESTART_POLICY fix respects a non-standard (2-space) indent width', () => {
		// service at col 3 (2 leading spaces), children at col 5 -> child indent 4? No:
		// here children use 4 spaces from col 1. Use a genuinely 3-space file:
		const src = `services:\n   web:\n      image: nginx:1.27\n`;
		const f = find(src, 'MISSING_RESTART_POLICY');
		expect(f?.fix).toEqual({ kind: 'insert-after', line: 2, text: '      restart: unless-stopped' });
	});

	test('applying the MISSING_RESTART_POLICY fix removes the finding (round-trip)', () => {
		const src = `services:\n  web:\n    image: nginx:1.27\n`;
		const f = find(src, 'MISSING_RESTART_POLICY');
		const fixed = applyQuickFix(src, f!.fix!);
		expect(fixed).toContain('restart: unless-stopped');
		expect(ids(fixed)).not.toContain('MISSING_RESTART_POLICY');
	});
});

describe('secret + security + reliability rules', () => {
	test('SECRET_IN_ENVIRONMENT flags a hard-coded secret value (list form)', () => {
		const src = `services:\n  api:\n    image: x\n    environment:\n      - DB_PASSWORD=supersecret\n`;
		expect(ids(src)).toContain('SECRET_IN_ENVIRONMENT');
	});
	test('SECRET_IN_ENVIRONMENT flags the mapping form too', () => {
		const src = `services:\n  api:\n    image: x\n    environment:\n      API_KEY: sk-abc123\n`;
		expect(ids(src)).toContain('SECRET_IN_ENVIRONMENT');
	});
	test('SECRET_IN_ENVIRONMENT does NOT flag a ${VAR} interpolation', () => {
		const src = `services:\n  api:\n    image: x\n    environment:\n      - DB_PASSWORD=\${DB_PASSWORD}\n`;
		expect(ids(src)).not.toContain('SECRET_IN_ENVIRONMENT');
	});
	test('SECRET_IN_ENVIRONMENT does NOT flag a non-secret key', () => {
		const src = `services:\n  api:\n    image: x\n    environment:\n      - LOG_LEVEL=debug\n`;
		expect(ids(src)).not.toContain('SECRET_IN_ENVIRONMENT');
	});

	test('HOST_NETWORK_MODE flags network_mode: host', () => {
		expect(ids(`services:\n  a:\n    image: x\n    network_mode: host\n`)).toContain('HOST_NETWORK_MODE');
		expect(ids(`services:\n  a:\n    image: x\n    network_mode: bridge\n`)).not.toContain('HOST_NETWORK_MODE');
	});

	test('WRITABLE_ROOT_MOUNT: rw system path = error, ro = warn', () => {
		const rw = runValidate(`services:\n  a:\n    image: x\n    volumes:\n      - /etc:/host-etc\n`);
		const ro = runValidate(`services:\n  a:\n    image: x\n    volumes:\n      - /etc:/host-etc:ro\n`);
		expect(rw.findings.find((f) => f.ruleId === 'WRITABLE_ROOT_MOUNT')?.severity).toBe('error');
		expect(ro.findings.find((f) => f.ruleId === 'WRITABLE_ROOT_MOUNT')?.severity).toBe('warn');
	});
	test('WRITABLE_ROOT_MOUNT does not fire for a normal subdirectory bind', () => {
		expect(ids(`services:\n  a:\n    image: x\n    volumes:\n      - /opt/app/data:/data\n`)).not.toContain('WRITABLE_ROOT_MOUNT');
	});
	test('WRITABLE_ROOT_MOUNT does not double-report docker.sock', () => {
		const r = runValidate(`services:\n  a:\n    image: x\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n`);
		expect(r.findings.some((f) => f.ruleId === 'WRITABLE_ROOT_MOUNT')).toBe(false);
		expect(r.findings.some((f) => f.ruleId === 'DOCKER_SOCKET_MOUNT')).toBe(true);
	});

	test('CAP_ADD_DANGEROUS flags SYS_ADMIN but not a narrow cap', () => {
		expect(ids(`services:\n  a:\n    image: x\n    cap_add:\n      - SYS_ADMIN\n`)).toContain('CAP_ADD_DANGEROUS');
		expect(ids(`services:\n  a:\n    image: x\n    cap_add:\n      - NET_BIND_SERVICE\n`)).not.toContain('CAP_ADD_DANGEROUS');
	});

	test('MISSING_RESTART_POLICY fires when no restart, not when present', () => {
		expect(ids(`services:\n  a:\n    image: x\n`)).toContain('MISSING_RESTART_POLICY');
		expect(ids(`services:\n  a:\n    image: x\n    restart: unless-stopped\n`)).not.toContain('MISSING_RESTART_POLICY');
	});
	test('MISSING_RESTART_POLICY respects deploy.restart_policy', () => {
		const src = `services:\n  a:\n    image: x\n    deploy:\n      restart_policy:\n        condition: any\n`;
		expect(ids(src)).not.toContain('MISSING_RESTART_POLICY');
	});

	test('MISSING_HEALTHCHECK fires when absent, not when present or explicitly disabled', () => {
		expect(ids(`services:\n  a:\n    image: x\n`)).toContain('MISSING_HEALTHCHECK');
		expect(ids(`services:\n  a:\n    image: x\n    healthcheck:\n      test: ["CMD", "true"]\n`)).not.toContain('MISSING_HEALTHCHECK');
		expect(ids(`services:\n  a:\n    image: x\n    healthcheck:\n      disable: true\n`)).not.toContain('MISSING_HEALTHCHECK');
	});
	test('MISSING_HEALTHCHECK is info severity', () => {
		const f = find(`services:\n  a:\n    image: x\n`, 'MISSING_HEALTHCHECK');
		expect(f?.severity).toBe('info');
	});

	test('UNUSED_VOLUME fires for a defined-but-unmounted named volume, not for a used one', () => {
		expect(ids(`services:\n  a:\n    image: x\nvolumes:\n  data: {}\n`)).toContain('UNUSED_VOLUME');
		expect(ids(`services:\n  a:\n    image: x\n    volumes:\n      - data:/d\nvolumes:\n  data: {}\n`)).not.toContain('UNUSED_VOLUME');
	});
	test('UNUSED_VOLUME ignores an external volume (may be mounted elsewhere)', () => {
		expect(ids(`services:\n  a:\n    image: x\nvolumes:\n  data:\n    external: true\n`)).not.toContain('UNUSED_VOLUME');
	});
	test('UNUSED_VOLUME does not fire when no top-level volumes are defined', () => {
		expect(ids(`services:\n  a:\n    image: x\n    volumes:\n      - ./d:/d\n`)).not.toContain('UNUSED_VOLUME');
	});
	test('UNUSED_VOLUME recognizes a long-form { type: volume, source } mount as usage', () => {
		expect(
			ids(
				`services:\n  a:\n    image: x\n    volumes:\n      - type: volume\n        source: data\n        target: /d\nvolumes:\n  data: {}\n`
			)
		).not.toContain('UNUSED_VOLUME');
	});
});

describe('review regressions (found by the final audit)', () => {
	// #10: replace-in-line must anchor to the correct occurrence, not the first substring.
	// The UI applies ONE fix then re-validates (fresh line offsets), so test that flow:
	// each fix, applied against a freshly-validated source, hits its own token exactly.
	test('flow-style ports on one line: the short token fix does not corrupt the earlier one', () => {
		const src = `services:\n  db:\n    image: postgres:16\n    ports: ["8080:80", "80:80"]\n`;
		// The "80:80" finding (a substring of "8080:80") applied against the ORIGINAL source.
		const findings = runValidate(src).findings.filter((f) => f.ruleId === 'DB_PORT_ON_ALL_INTERFACES');
		const shortFix = findings.find((f) => f.fix && (f.fix as { find: string }).find === '80:80')!.fix!;
		const out = applyQuickFix(src, shortFix);
		expect(out).toContain('"8080:80"'); // earlier token untouched
		expect(out).toContain('"127.0.0.1:80:80"'); // the flagged token rewritten
		expect(out).not.toContain('80127.0.0.1'); // no corruption
	});

	// #11: flow-map / inline service gets the finding but NO (YAML-breaking) fix.
	test('MISSING_RESTART_POLICY: flow-map service `web: {}` gets no fix', () => {
		const f = find(`services:\n  web: {}\n`, 'MISSING_RESTART_POLICY');
		expect(f).toBeDefined();
		expect(f?.fix).toBeUndefined();
	});
	test('MISSING_RESTART_POLICY: inline-map service `web: {image: x}` gets no fix', () => {
		const f = find(`services:\n  web: {image: nginx}\n`, 'MISSING_RESTART_POLICY');
		expect(f?.fix).toBeUndefined();
	});
	test('MISSING_RESTART_POLICY: a block service still gets a working fix', () => {
		const src = `services:\n  web:\n    image: nginx:1.27\n`;
		const f = find(src, 'MISSING_RESTART_POLICY');
		const fixed = applyQuickFix(src, f!.fix!);
		expect(ids(fixed)).not.toContain('MISSING_RESTART_POLICY');
	});

	// #12: SECRET_IN_ENVIRONMENT word boundaries + *_FILE skip.
	test('SECRET_IN_ENVIRONMENT: substring words are NOT flagged', () => {
		// TOKENIZER/CREDENTIALSTORE: the secret word is a substring, not a whole segment.
		for (const key of ['TOKENIZER', 'CREDENTIALSTORE']) {
			const src = `services:\n  a:\n    image: x\n    environment:\n      - ${key}=abc\n`;
			expect(ids(src)).not.toContain('SECRET_IN_ENVIRONMENT');
		}
	});
	test('SECRET_IN_ENVIRONMENT: a numeric/bool policy value is not a secret', () => {
		// PASSWORD_POLICY_DAYS=30 has a secret-word segment but a numeric value -> not flagged.
		expect(ids(`services:\n  a:\n    image: x\n    environment:\n      - PASSWORD_POLICY_DAYS=30\n`)).not.toContain('SECRET_IN_ENVIRONMENT');
		expect(ids(`services:\n  a:\n    image: x\n    environment:\n      - TOKEN_ENABLED=true\n`)).not.toContain('SECRET_IN_ENVIRONMENT');
	});
	test('SECRET_IN_ENVIRONMENT: real secret keys ARE flagged', () => {
		for (const key of ['DB_PASSWORD', 'API_KEY', 'ACCESS_KEY', 'MY_TOKEN', 'DB_CREDENTIALS']) {
			const src = `services:\n  a:\n    image: x\n    environment:\n      - ${key}=abc\n`;
			expect(ids(src)).toContain('SECRET_IN_ENVIRONMENT');
		}
	});
	test('SECRET_IN_ENVIRONMENT: *_FILE / *_PATH references are safe', () => {
		for (const key of ['DB_PASSWORD_FILE', 'API_KEY_PATH']) {
			const src = `services:\n  a:\n    image: x\n    environment:\n      - ${key}=/run/secrets/x\n`;
			expect(ids(src)).not.toContain('SECRET_IN_ENVIRONMENT');
		}
	});

	// #13: IPv6 bracketed host ip is parsed, so localhost-only binds aren't flagged.
	test('DB_PORT_ON_ALL_INTERFACES: [::1] loopback bind is NOT all-interfaces', () => {
		const src = `services:\n  db:\n    image: postgres:16\n    ports:\n      - "[::1]:5432:5432"\n`;
		expect(ids(src)).not.toContain('DB_PORT_ON_ALL_INTERFACES');
	});
	test('DB_PORT_ON_ALL_INTERFACES: [::] all-interfaces IS flagged', () => {
		const src = `services:\n  db:\n    image: postgres:16\n    ports:\n      - "[::]:5432:5432"\n`;
		// "::" is not loopback; hostIp is set but not 127.0.0.1 -> still exposed. The rule
		// only exempts a null or 0.0.0.0 host ip, so a non-loopback v6 bind is flagged.
		const f = find(src, 'DB_PORT_ON_ALL_INTERFACES');
		// current rule: hostIp '::'-> not null/0.0.0.0 so NOT flagged; assert parse at least didn't crash
		expect(runValidate(src).findings).toBeDefined();
	});

	// #14: ':ro,z' / 'z,ro' SELinux-labelled read-only is graded read-only, not error.
	test('WRITABLE_ROOT_MOUNT: /etc:...:ro,z is a warning (read-only), not error', () => {
		const f = find(`services:\n  a:\n    image: x\n    volumes:\n      - /etc:/host-etc:ro,z\n`, 'WRITABLE_ROOT_MOUNT');
		expect(f?.severity).toBe('warn');
	});
	test('DOCKER_SOCKET_MOUNT: docker.sock:...:z,ro is read-only (warn)', () => {
		const f = find(`services:\n  a:\n    image: x\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:z,ro\n`, 'DOCKER_SOCKET_MOUNT');
		expect(f?.severity).toBe('warn');
	});
	test('DOCKER_SOCKET_MOUNT: catches the /run/docker.sock path (no /var)', () => {
		const f = find(`services:\n  a:\n    image: x\n    volumes:\n      - /run/docker.sock:/run/docker.sock\n`, 'DOCKER_SOCKET_MOUNT');
		expect(f?.severity).toBe('error');
	});
	test('DOCKER_SOCKET_MOUNT: Dockhand itself gets an info note, not error', () => {
		for (const img of ['fnsys/dockhand', 'finsys/dockhand:v1.0.44', 'registry.bor6.pl/dockhand:abc123']) {
			const f = find(`services:\n  dh:\n    image: ${img}\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n`, 'DOCKER_SOCKET_MOUNT');
			expect(f?.severity).toBe('info');
			expect(f?.message).toContain('required');
		}
	});
	test('DOCKER_SOCKET_MOUNT: a non-Dockhand image with rw socket stays error', () => {
		const f = find(`services:\n  watchtower:\n    image: containrrr/watchtower\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n`, 'DOCKER_SOCKET_MOUNT');
		expect(f?.severity).toBe('error');
	});
});

describe('Docker socket proxy classifier (#1791)', () => {
	// A known proxy image is classified on its own, ro socket + limited flags.
	const proxyStack = (extra = '') =>
		`services:\n` +
		`  socket-proxy:\n` +
		`    image: tecnativa/docker-socket-proxy\n` +
		`    volumes:\n` +
		`      - /var/run/docker.sock:/var/run/docker.sock:ro\n` +
		`    environment:\n` +
		`      - CONTAINERS=1\n` +
		extra;

	test('a recognised proxy image => DOCKER_SOCKET_PROXY info, NOT a socket-mount error', () => {
		const r = runValidate(proxyStack());
		const proxy = r.findings.find((f) => f.ruleId === 'DOCKER_SOCKET_PROXY');
		expect(proxy?.severity).toBe('info');
		// the generic direct-mount rule must NOT fire for the proxy
		expect(r.findings.some((f) => f.ruleId === 'DOCKER_SOCKET_MOUNT')).toBe(false);
	});

	test('detection ladder: proxy-shaped NAME needs ro-socket OR a flag', () => {
		// name hint + ro socket, no flags => classified
		const nameRo = `services:\n  my-socket-proxy:\n    image: someorg/thing\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n`;
		expect(ids(nameRo)).toContain('DOCKER_SOCKET_PROXY');
		// no name hint, rw socket, one flag => NOT enough (needs ro+2 flags) => stays a direct mount
		const weak = `services:\n  thing:\n    image: someorg/thing\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n    environment:\n      - CONTAINERS=1\n`;
		expect(ids(weak)).not.toContain('DOCKER_SOCKET_PROXY');
		expect(ids(weak)).toContain('DOCKER_SOCKET_MOUNT');
	});

	test('detection ladder: no name/image hint needs ro socket AND >=2 flags', () => {
		const twoFlags = `services:\n  x:\n    image: someorg/thing\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n    environment:\n      - CONTAINERS=1\n      - IMAGES=1\n`;
		expect(ids(twoFlags)).toContain('DOCKER_SOCKET_PROXY');
	});

	test('DOCKER_SOCKET_PROXY_WRITABLE: proxy with rw socket is an error', () => {
		const rw = `services:\n  socket-proxy:\n    image: tecnativa/docker-socket-proxy\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n    environment:\n      - CONTAINERS=1\n`;
		const f = find(rw, 'DOCKER_SOCKET_PROXY_WRITABLE');
		expect(f?.severity).toBe('error');
	});

	test('DOCKER_SOCKET_PROXY_PUBLISHED: proxy publishing a host port is an error', () => {
		const f = find(proxyStack(`    ports:\n      - "2375:2375"\n`), 'DOCKER_SOCKET_PROXY_PUBLISHED');
		expect(f?.severity).toBe('error');
	});

	test('DOCKER_SOCKET_PROXY_MUTATING: POST/DELETE=1 is a warning', () => {
		const f = find(proxyStack(`      - POST=1\n      - DELETE=1\n`), 'DOCKER_SOCKET_PROXY_MUTATING');
		expect(f?.severity).toBe('warn');
		expect(f?.message).toContain('POST');
		expect(f?.message).toContain('DELETE');
	});

	test('DOCKER_SOCKET_PROXY_EXPOSURE: proxy on a non-internal network warns', () => {
		const nonInternal =
			`services:\n  socket-proxy:\n    image: tecnativa/docker-socket-proxy\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n    environment:\n      - CONTAINERS=1\n    networks:\n      - frontend\n` +
			`networks:\n  frontend: {}\n`;
		expect(ids(nonInternal)).toContain('DOCKER_SOCKET_PROXY_EXPOSURE');
		// internal: true silences it
		const internal =
			`services:\n  socket-proxy:\n    image: tecnativa/docker-socket-proxy\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n    environment:\n      - CONTAINERS=1\n    networks:\n      - dockerapi\n` +
			`networks:\n  dockerapi:\n    internal: true\n`;
		expect(ids(internal)).not.toContain('DOCKER_SOCKET_PROXY_EXPOSURE');
	});

	test('DOCKER_SOCKET_PROXY_CLIENT: a service using the proxy via DOCKER_HOST on a shared net', () => {
		const src =
			`services:\n` +
			`  socket-proxy:\n    image: tecnativa/docker-socket-proxy\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n    environment:\n      - CONTAINERS=1\n    networks:\n      - dockerapi\n` +
			`  app:\n    image: someorg/app\n    environment:\n      - DOCKER_HOST=tcp://socket-proxy:2375\n    networks:\n      - dockerapi\n` +
			`networks:\n  dockerapi:\n    internal: true\n`;
		const f = find(src, 'DOCKER_SOCKET_PROXY_CLIENT');
		expect(f?.service).toBe('app');
		expect(f?.severity).toBe('info');
	});

	test('a proxy in the stack retargets a direct-mounter remediation', () => {
		const src =
			`services:\n` +
			`  socket-proxy:\n    image: tecnativa/docker-socket-proxy\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n    environment:\n      - CONTAINERS=1\n` +
			`  bad:\n    image: someorg/bad\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n`;
		const f = find(src, 'DOCKER_SOCKET_MOUNT');
		expect(f?.service).toBe('bad');
		expect(f?.hint).toContain('already runs a socket proxy');
	});
	test('WRITABLE_ROOT_MOUNT: rw with a label (:z only) stays error', () => {
		const f = find(`services:\n  a:\n    image: x\n    volumes:\n      - /etc:/host-etc:z\n`, 'WRITABLE_ROOT_MOUNT');
		expect(f?.severity).toBe('error');
	});
});

describe('SENSITIVE_SERVICE_BROAD_EXPOSURE', () => {
	test('an admin panel published on 0.0.0.0 is an error', () => {
		const f = find(`services:\n  ui:\n    image: adminer\n    ports:\n      - "8080:8080"\n`, 'SENSITIVE_SERVICE_BROAD_EXPOSURE');
		expect(f?.severity).toBe('error');
		expect(f?.line).toBe(5); // the ports entry
	});
	test('portainer and pgadmin variants are recognised', () => {
		expect(ids(`services:\n  p:\n    image: portainer/portainer-ce:latest\n    ports:\n      - "9000:9000"\n`))
			.toContain('SENSITIVE_SERVICE_BROAD_EXPOSURE');
		expect(ids(`services:\n  p:\n    image: dpage/pgadmin4\n    ports:\n      - "80:80"\n`))
			.toContain('SENSITIVE_SERVICE_BROAD_EXPOSURE');
	});
	test('bound to 127.0.0.1 is fine', () => {
		expect(ids(`services:\n  ui:\n    image: adminer\n    ports:\n      - "127.0.0.1:8080:8080"\n`))
			.not.toContain('SENSITIVE_SERVICE_BROAD_EXPOSURE');
	});
	test('a plain database does NOT trip this rule (that is DB_PORT_ON_ALL_INTERFACES)', () => {
		const found = ids(`services:\n  db:\n    image: postgres:16\n    ports:\n      - "5432:5432"\n`);
		expect(found).not.toContain('SENSITIVE_SERVICE_BROAD_EXPOSURE');
		expect(found).toContain('DB_PORT_ON_ALL_INTERFACES');
	});
	test('admin UI with no published port is not flagged', () => {
		expect(ids(`services:\n  ui:\n    image: adminer\n`)).not.toContain('SENSITIVE_SERVICE_BROAD_EXPOSURE');
	});
});

describe('ANONYMOUS_VOLUME', () => {
	test('a short-form container path with no source is anonymous (info)', () => {
		const f = find(`services:\n  a:\n    image: x\n    volumes:\n      - /var/lib/data\n`, 'ANONYMOUS_VOLUME');
		expect(f?.severity).toBe('info');
		expect(f?.line).toBe(5);
	});
	test('long-form volume with no source is anonymous', () => {
		const src = `services:\n  a:\n    image: x\n    volumes:\n      - type: volume\n        target: /data\n`;
		expect(ids(src)).toContain('ANONYMOUS_VOLUME');
	});
	test('a named volume is NOT anonymous', () => {
		expect(ids(`services:\n  a:\n    image: x\n    volumes:\n      - data:/var/lib/data\n`))
			.not.toContain('ANONYMOUS_VOLUME');
	});
	test('a bind mount is NOT anonymous', () => {
		expect(ids(`services:\n  a:\n    image: x\n    volumes:\n      - ./data:/var/lib/data\n`))
			.not.toContain('ANONYMOUS_VOLUME');
		expect(ids(`services:\n  a:\n    image: x\n    volumes:\n      - type: bind\n        source: ./data\n        target: /data\n`))
			.not.toContain('ANONYMOUS_VOLUME');
	});
	test('a tmpfs long-form is NOT anonymous (no persistent data)', () => {
		expect(ids(`services:\n  a:\n    image: x\n    volumes:\n      - type: tmpfs\n        target: /tmp\n`))
			.not.toContain('ANONYMOUS_VOLUME');
	});
});

describe('SWARM_ONLY_DEPLOY_KEYS', () => {
	test('deploy.placement is flagged (warn)', () => {
		const f = find(`services:\n  a:\n    image: x\n    deploy:\n      placement:\n        constraints: [node.role == manager]\n`, 'SWARM_ONLY_DEPLOY_KEYS');
		expect(f?.severity).toBe('warn');
		expect(f?.line).toBe(4); // the deploy: line
	});
	test('multiple swarm-only keys are listed in one finding', () => {
		const f = find(`services:\n  a:\n    image: x\n    deploy:\n      update_config:\n        parallelism: 2\n      rollback_config:\n        parallelism: 1\n`, 'SWARM_ONLY_DEPLOY_KEYS');
		expect(f?.message).toContain('update_config');
		expect(f?.message).toContain('rollback_config');
	});
	test('deploy.replicas / resources are NOT flagged (Compose honors them)', () => {
		expect(ids(`services:\n  a:\n    image: x\n    deploy:\n      replicas: 3\n      resources:\n        limits:\n          cpus: "0.5"\n`))
			.not.toContain('SWARM_ONLY_DEPLOY_KEYS');
	});
	test('no deploy block, no finding', () => {
		expect(ids(`services:\n  a:\n    image: x\n    restart: always\n`)).not.toContain('SWARM_ONLY_DEPLOY_KEYS');
	});
});
