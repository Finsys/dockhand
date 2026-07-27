/**
 * backups/restic.ts — the ONE way this codebase runs restic.
 *
 * There are exactly two ways restic has to run, and this class is the only place
 * that knows the difference:
 *
 *   runLocal()    — restic on the Dockhand host, talking straight to the repo.
 *                   Used for every repo-only operation: snapshots, ls, dump,
 *                   forget, check, init, unlock, stats, diff, key. No container
 *                   needed because these don't touch a target's volumes.
 *
 *   runInHelper() — restic inside a single throwaway helper container that has
 *                   the target's volumes bind-mounted. Used for backup and
 *                   restore, which must read/write the actual volume data. This
 *                   is the "one session container, do the work, close it" path.
 *
 * Both return a `ResticRun` and NEVER throw for an operational outcome — the
 * caller inspects `exitCode` and decides. `exitCode === undefined` means we
 * genuinely could not determine the outcome (a killed helper, a daemon hiccup);
 * callers treat that as failure so an unknown outcome is never a silent success.
 *
 * The security-sensitive pieces (which env vars, which flags, which binds) live
 * in one place here, built from the hardened allowlists in ./security — never
 * from the raw process environment or unfiltered user input.
 */
import { spawn } from 'child_process';
import { runContainerWithStreaming, inspectImage, pullImage, putContainerArchive } from '../docker';
import { buildTar } from './tar';
import type { MetadataFile } from './backup-script';
import { getInstanceId } from './identity';
import { decryptBackupDestination, getSetting } from '../db';
import type { BackupDestination } from '../db';
import {
	buildResticEnv,
	filterCloudEnvVars,
	sanitizeResticFlags,
} from './security';
import { TIMEOUTS, type ResticRun, type TimeoutTier } from './models';
import { withTimeout } from './helpers';
import { resticCommand, finishScript, readExitMarker, buildHelperEnv, buildHelperBinds } from './restic-script';
import { translateContainerPathViaMount } from '../host-path';

/** The label key stamped on every helper container so a reaper only removes
 * containers THIS installation created (never a co-located install's helper on a
 * shared Docker daemon). */
const INSTANCE_LABEL = 'dockhand.instance';

/** Default helper image (restic + GNU tar), pinned to THIS Dockhand's version so an
 * app upgrade pulls the matching helper automatically (a floating `:latest` would
 * never re-pull once cached, leaving users on a stale helper). Falls back to
 * `:latest` only when the build didn't stamp a version (local dev).
 *
 * The baseline Dockhand image (old x86_64 CPUs without x86-64-v2) sets
 * DOCKHAND_VARIANT=baseline; its Wolfi helper would crash with SIGILL / "requires
 * v2 microarchitecture", so it uses the `-baseline` (Alpine/musl) helper instead.
 *
 * This is ONLY the default: the `default_backup_image` setting always wins (see
 * helperImage()), so a user who points the helper at their own registry/tag is never
 * overridden. */
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;
const HELPER_VARIANT_SUFFIX = process.env.DOCKHAND_VARIANT === 'baseline' ? '-baseline' : '';
export const DEFAULT_HELPER_IMAGE = APP_VERSION
	? `fnsys/dockhand-backup:${APP_VERSION}${HELPER_VARIANT_SUFFIX}`
	: `fnsys/dockhand-backup:latest${HELPER_VARIANT_SUFFIX}`;

export interface HelperRunSpec {
	/** The restic argv (without the leading `restic`). */
	args: string[];
	/** Volume/bind mounts for the helper, e.g. `myvol:/volumes/myvol:ro`. */
	binds: string[];
	/** Target environment id (null/undefined = local Docker daemon). */
	envId?: number | null;
	/** Container name prefix — one name per operation, for cancel + reap. */
	name: string;
	/** Streamed stderr callback for live progress parsing. */
	onStderr?: (line: string) => void;
	/** Opt-in live STDOUT callback. restic writes its `--json` progress to stdout, so
	 * without this the progress arrives buffered after the helper exits. Passing it
	 * streams that progress live. */
	onStdout?: (line: string) => void;
	/** Timeout tier; defaults to the data tier (long) for backup/restore. */
	timeout?: TimeoutTier;
	/** A full shell script to run instead of a bare restic argv. When set,
	 * `args` is ignored and the script runs via `sh -c`. The script MUST print
	 * the exit marker as its final line (use finishScript() to append it). */
	script?: string;
	/** Metadata/stack files to stream into the container's /metadata directory via
	 * the Docker put-archive API BEFORE it starts. Kept out of the Cmd so large
	 * stack files don't blow ARG_MAX. `path` is relative to /metadata. */
	metadataFiles?: MetadataFile[];
}

export class Restic {
	/**
	 * Run restic on the host. Resolves a ResticRun for EVERY outcome — a non-zero
	 * exit, a timeout (exitCode undefined + a signal), or a spawn error all come
	 * back as data, never as a thrown exception.
	 */
	async runLocal(
		destination: BackupDestination,
		args: string[],
		tier: TimeoutTier = 'interactive'
	): Promise<ResticRun> {
		const decrypted = decryptBackupDestination(destination);
		const env = buildResticEnv(process.env, {
			repository: destination.repository,
			password: decrypted.decryptedPassword,
			envVars: decrypted.decryptedEnvVars,
		});
		const fullArgs = [...args, ...sanitizeResticFlags(destination.flags)];

		return new Promise<ResticRun>((resolve) => {
			let stdout = '';
			let stderr = '';
			let settled = false;
			const done = (run: ResticRun) => { if (!settled) { settled = true; resolve(run); } };

			const proc = spawn('restic', fullArgs, { env, timeout: TIMEOUTS[tier] });
			proc.stdout.on('data', (d) => { stdout += d; });
			proc.stderr.on('data', (d) => { stderr += d; });
			proc.on('close', (code, signal) => {
				// A timeout kill gives code === null + a signal → exit is undefined
				// (unknown outcome), which the caller treats as failure.
				const exitCode = code === null ? undefined : code;
				const stderrOut = signal ? `${stderr}\n(process killed by ${signal})` : stderr;
				done({ exitCode, stdout, stderr: stderrOut });
			});
			proc.on('error', (err) => {
				// restic missing / not spawnable — a real failure, surfaced as data.
				done({ exitCode: undefined, stdout, stderr: `${stderr}\n${err.message}` });
			});
		});
	}

	/**
	 * Like runLocal, but captures stdout as raw bytes instead of a UTF-8 string.
	 * Used for `restic dump` of binary content (a file's bytes, or a `--archive tar`
	 * stream) where string concatenation would mangle any non-ASCII byte and split
	 * multibyte sequences at chunk boundaries. stderr stays text (restic diagnostics).
	 */
	async runLocalBinary(
		destination: BackupDestination,
		args: string[],
		tier: TimeoutTier = 'interactive'
	): Promise<{ exitCode: number | undefined; stdout: Buffer; stderr: string }> {
		const decrypted = decryptBackupDestination(destination);
		const env = buildResticEnv(process.env, {
			repository: destination.repository,
			password: decrypted.decryptedPassword,
			envVars: decrypted.decryptedEnvVars,
		});
		const fullArgs = [...args, ...sanitizeResticFlags(destination.flags)];

		return new Promise((resolve) => {
			const chunks: Buffer[] = [];
			let stderr = '';
			let settled = false;
			const done = (run: { exitCode: number | undefined; stdout: Buffer; stderr: string }) => {
				if (!settled) { settled = true; resolve(run); }
			};

			const proc = spawn('restic', fullArgs, { env, timeout: TIMEOUTS[tier] });
			proc.stdout.on('data', (d: Buffer) => { chunks.push(Buffer.from(d)); });
			proc.stderr.on('data', (d) => { stderr += d; });
			proc.on('close', (code, signal) => {
				const exitCode = code === null ? undefined : code;
				const stderrOut = signal ? `${stderr}\n(process killed by ${signal})` : stderr;
				done({ exitCode, stdout: Buffer.concat(chunks), stderr: stderrOut });
			});
			proc.on('error', (err) => {
				done({ exitCode: undefined, stdout: Buffer.concat(chunks), stderr: `${stderr}\n${err.message}` });
			});
		});
	}

	/**
	 * Run restic inside a single helper container with the target's volumes
	 * mounted. Resolves a ResticRun for every outcome. The helper reports its real
	 * restic exit code via the EXIT_MARKER line, so exit-3 (partial) is visible
	 * rather than collapsed into "container failed".
	 */
	async runInHelper(destination: BackupDestination, spec: HelperRunSpec): Promise<ResticRun> {
		const decrypted = decryptBackupDestination(destination);
		const env = buildHelperEnv(
			destination.repository,
			decrypted.decryptedPassword,
			filterCloudEnvVars(decrypted.decryptedEnvVars)
		);
		const binds = buildHelperBinds(destination.repository, spec.binds, (repo) =>
			destination.hostPath || translateLocalRepoPath(repo)
		);
		const image = await this.helperImage(spec.envId);
		// Both paths append the exit marker so readExitMarker() sees the real exit
		// code. A caller-supplied script (e.g. the in-place restore swap) may use
		// `set -e`, so capture its exit in a subshell — the marker line must still
		// print on success, otherwise a clean run reads back as undefined (failure).
		const cmd = spec.script
			? ['sh', '-c', finishScript(`( ${spec.script} )`)]
			: ['sh', '-c', finishScript(resticCommand([...spec.args, ...sanitizeResticFlags(destination.flags)]))];

		// Large metadata/stack files go into the container via put-archive (docker
		// cp), NOT the Cmd, so they can't blow ARG_MAX. Build the tar once; stream
		// it into /metadata after create, before start.
		const metadataFiles = spec.metadataFiles ?? [];
		const beforeStart = metadataFiles.length > 0
			? async (containerId: string) => {
				const tar = await buildTar(metadataFiles.map((f) => ({
					path: `metadata/${f.path.replace(/^\/+/, '')}`,
					content: Buffer.from(f.contentBase64, 'base64'),
				})));
				// Extract at / — the archive entries are already rooted at metadata/.
				await putContainerArchive(containerId, '/', tar, spec.envId);
			}
			: undefined;

		let stdout = '';
		let stderr = '';
		try {
			stdout = await runContainerWithStreaming({
				image,
				cmd,
				binds,
				env,
				name: spec.name,
				labels: { [INSTANCE_LABEL]: await getInstanceId() },
				envId: spec.envId ?? undefined,
				beforeStart,
				onStderr: (data) => {
					stderr += data;
					if (spec.onStderr) for (const line of data.split('\n')) if (line.trim()) spec.onStderr(line);
				},
				// Opt-in: forward live stdout lines to the spec's onStdout. The buffered
				// `stdout` above stays the source of truth for summary parsing (post-exit);
				// this only mirrors the same lines LIVE to the caller. Only wired when the
				// caller asked for it, so non-backup callers are unaffected.
				onStdout: spec.onStdout
					? (data) => { for (const line of data.split('\n')) if (line.trim()) spec.onStdout!(line); }
					: undefined,
				timeout: TIMEOUTS[spec.timeout ?? 'data'],
			});
			// The container exited 0 as a shell (we don't use `set -e` for the
			// restic step); the REAL restic exit code is in the marker line.
			return { exitCode: readExitMarker(stdout), stdout, stderr };
		} catch (err) {
			// runContainerWithStreaming throws on a non-zero/indeterminate CONTAINER
			// exit or a timeout. That means the helper itself failed (not restic
			// reporting a code) — an unknown outcome. Surface it as undefined-exit
			// data, never as a thrown error, so the caller fails closed.
			const message = err instanceof Error ? err.message : String(err);
			return { exitCode: undefined, stdout, stderr: `${stderr}\n${message}` };
		}
	}

	// --- internals -----------------------------------------------------------

	/** Resolve the helper image, pulling it only if genuinely absent (a 404 on
	 * inspect). Any other daemon error propagates rather than triggering an
	 * unnecessary pull. */
	private async helperImage(envId?: number | null): Promise<string> {
		const image = (await getSetting('default_backup_image')) || DEFAULT_HELPER_IMAGE;
		// FAIL FAST: resolving the helper image must never hang. inspectImage /
		// pullImage go through dockerFetch with `streaming: true`, which on a TCP/mTLS
		// env carries NO request timeout — a stalled pull (registry unreachable, dead
		// TCP) would otherwise wait out the whole backup op timeout (data tier = 6h)
		// with the operation stuck before it ever starts. Bound both steps so a
		// helper-image problem surfaces in seconds/minutes as a clear error instead.
		let exists = true;
		try {
			await withTimeout(inspectImage(image, envId ?? undefined), HELPER_INSPECT_TIMEOUT_MS,
				`timed out inspecting helper image "${image}"`);
		} catch (err: any) {
			if (err?.statusCode === 404) exists = false;
			else throw err; // a real inspect error or a timeout BackupError — surface it
		}
		if (!exists) {
			console.log(`[Backups] Pulling helper image: ${image}`);
			await withTimeout(pullImage(image, undefined, envId ?? undefined), HELPER_PULL_TIMEOUT_MS,
				`timed out pulling helper image "${image}" — check that it is available and the registry is reachable`);
		}
		return image;
	}
}

/** Helper-image resolution timeouts (fail-fast so a stalled pull never hangs a
 * backup). Overridable for slow links / large images. */
const HELPER_INSPECT_TIMEOUT_MS = Number(process.env.BACKUP_HELPER_INSPECT_TIMEOUT ?? 20_000);
const HELPER_PULL_TIMEOUT_MS = Number(process.env.BACKUP_HELPER_PULL_TIMEOUT ?? 300_000);

/** Translate an in-container repo path to its host path for the bind mount. */
function translateLocalRepoPath(repoPath: string): string {
	return translateContainerPathViaMount(repoPath) || repoPath;
}
