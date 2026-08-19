/**
 * Effective-compose provider via `docker compose config`.
 *
 * `docker compose config` is Docker's OWN validator: it renders the fully effective
 * compose (interpolation + env_file + profiles + include + extends + overrides) and
 * errors on any schema/syntax violation. We use it for two things:
 *   1. authoritative schema/syntax findings (its stderr), and
 *   2. the effective compose object the context-aware rules reason about.
 *
 * It is NOT a replacement for the rule catalog: `config` only says valid/invalid per
 * schema - it can't know a host port is taken by another stack, that a key is a typo
 * (it drops unknown keys just like `up`), or the transport/bind reality. Those stay in
 * rules.ts. And `config`'s output is re-serialized, so its lines do NOT map to the
 * user's original file - editor markers use the local position map (parse.ts), not this.
 *
 * Runs the daemon, so it's the deploy-time / env-online path. Edit-time falls back to
 * the local parser. Best-effort: any failure returns { ok: false } and the caller uses
 * the local parse instead of blocking.
 */

import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveComposeDockerHost, buildComposeBaseArgs } from '../compose-docker-args';
import type { Finding } from './types';

const CONFIG_TIMEOUT_MS = 20_000;
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const STDERR_LIMIT = 256 * 1024;
const KILL_GRACE_MS = 2_000;

export interface EffectiveComposeResult {
	/** true when `docker compose config` ran and validated the file. */
	ok: boolean;
	/** The rendered effective compose object (for the rules), when ok. */
	effective?: Record<string, unknown>;
	/** Schema/syntax findings extracted from `config` stderr (severity: error). */
	findings: Finding[];
}

/**
 * Run `docker compose config` for a compose string on the given daemon. `dockerHost`
 * is the resolved TCP/socket host for the target env (null/undefined = local socket).
 * Never throws; failure yields { ok: false, findings: [] } so the caller degrades to
 * the local parser.
 */
export async function renderEffectiveCompose(
	stackName: string,
	composeContent: string,
	dockerHost?: string | null,
	envVars?: Record<string, string>
): Promise<EffectiveComposeResult> {
	let dir: string | undefined;
	try {
		dir = await mkdtemp(join(tmpdir(), 'dockhand-validate-'));
		await chmod(dir, 0o700);
		const file = join(dir, 'docker-compose.yml');
		await writeFile(file, composeContent, 'utf8');

		const composeDockerHost = resolveComposeDockerHost(dockerHost, undefined);
		const base = buildComposeBaseArgs(stackName, composeDockerHost); // ['docker', ('-H' host)?, 'compose', '-p', name]
		// `--format json` renders the FULLY effective compose as JSON: interpolation,
		// env_file, profiles, include, extends, overrides all resolved, ports normalized
		// to long form. This is the authoritative object our context-aware rules reason
		// about - far better than the raw ${VAR} source.
		const args = [...base.slice(1), '-f', file, 'config', '--format', 'json'];

		const { code, stdout, stderr } = await execDocker(base[0], args, dir, envVars);

		if (code === 0) {
			let effective: Record<string, unknown> | undefined;
			try {
				const parsed = JSON.parse(stdout);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					effective = parsed as Record<string, unknown>;
				}
			} catch {
				// config succeeded but output unparseable - treat as no effective object
			}
			return { ok: true, effective, findings: [] };
		}

		// Non-zero: config found a schema/syntax problem. Surface it as an error finding.
		return { ok: false, findings: parseConfigErrors(stderr) };
	} catch {
		// docker missing / daemon unreachable / spawn error: degrade silently.
		return { ok: false, findings: [] };
	} finally {
		if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** Turn `docker compose config` stderr into schema findings. Each non-empty, non-noise
 *  line becomes an error finding; a `line: N` hint in the message is lifted when present. */
export function parseConfigErrors(stderr: string): Finding[] {
	const findings: Finding[] = [];
	const seen = new Set<string>();
	for (const rawLine of stderr.split('\n')) {
		const line = rawLine.trim();
		if (!line) continue;
		// Drop docker's generic framing so only the actual validation message shows.
		// `validating <path>: services.x ...` -> strip the leading verb AND the temp
		// compose-file path we wrote it to (users never see that scratch path).
		const msg = line
			.replace(/^validating\s+/i, '')
			.replace(/^error:\s*/i, '')
			.replace(/^time=".*?"\s+level=\w+\s+msg="?/i, '')
			.replace(/^\S*\.ya?ml:\s*/i, '')
			.replace(/"$/, '')
			.trim();
		if (!msg || seen.has(msg)) continue;
		seen.add(msg);
		const lineMatch = /line\s+(\d+)/i.exec(msg);
		findings.push({
			ruleId: 'COMPOSE_SCHEMA_ERROR',
			severity: 'error',
			message: msg.slice(0, 400),
			hint: 'Reported by `docker compose config` - the file will not deploy as-is.',
			line: lineMatch ? Number(lineMatch[1]) : undefined
		});
	}
	// If config failed but printed nothing useful, still record one error.
	if (findings.length === 0) {
		findings.push({
			ruleId: 'COMPOSE_SCHEMA_ERROR',
			severity: 'error',
			message: 'docker compose config rejected the file (no detail provided)',
			hint: 'Run `docker compose config` locally to see the full error.'
		});
	}
	return findings;
}

/** Spawn helper: shell:false, bounded output + lifetime, returns code/stdout/stderr. */
function execDocker(
	exe: string,
	args: string[],
	cwd: string,
	envVars?: Record<string, string>
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const outChunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		let outBytes = 0;
		let errBytes = 0;
		let settled = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;

		const child = spawn(exe, args, {
			cwd,
			shell: false,
			stdio: ['ignore', 'pipe', 'pipe'],
			// The stack's env vars (incl. secrets) are injected so `${VAR}` interpolation
			// resolves the same way it will at deploy time - otherwise config reports a
			// spurious "VAR is not set" for every variable Dockhand supplies via shell env.
			env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', ...(envVars ?? {}) }
		});

		const timeout = setTimeout(() => {
			try {
				child.kill('SIGTERM');
			} catch {
				/* close handler settles */
			}
			killTimer = setTimeout(() => {
				try {
					child.kill('SIGKILL');
				} catch {
					/* ignore */
				}
			}, KILL_GRACE_MS);
		}, CONFIG_TIMEOUT_MS);

		child.stdout?.on('data', (c: Buffer) => {
			outBytes += c.length;
			if (outBytes <= OUTPUT_LIMIT) outChunks.push(c);
		});
		child.stderr?.on('data', (c: Buffer) => {
			errBytes += c.length;
			if (errBytes <= STDERR_LIMIT) errChunks.push(c);
		});

		child.once('error', (e) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			reject(e);
		});
		child.once('close', (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			resolve({
				code: code ?? 1,
				stdout: Buffer.concat(outChunks).toString('utf8'),
				stderr: Buffer.concat(errChunks).toString('utf8')
			});
		});
	});
}
