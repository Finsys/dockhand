/**
 * The two ways restic runs, and the only place that knows the difference:
 *   runLocal()    - restic on the Dockhand host, straight to the repo. Repo-only
 *                   ops (snapshots, ls, dump, forget, check, init, unlock, stats,
 *                   diff, key): no container, they don't touch a target's volumes.
 *   runInHelper() - restic inside a single throwaway helper container with the
 *                   target's volumes bind-mounted. Backup + restore only.
 *
 * Both return a `ResticRun` and NEVER throw for an operational outcome; the caller
 * inspects `exitCode`. `exitCode === undefined` = outcome could not be determined
 * (killed helper, daemon hiccup) and the caller treats it as failure, so an
 * unknown outcome is never a silent success.
 *
 * Env vars / flags / binds are built from the hardened allowlists in ./security,
 * never from the raw process environment or unfiltered user input.
 */
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { withTimeout, parseBackupFlags } from './helpers';
import { resticCommand, finishScript, readExitMarker, buildHelperEnv, buildHelperBinds, localRepoGuard, localRepoChown, classifyProcClose, classifyProcError, gcsCredentialPreamble, tlsCertPreamble } from './restic-script';
import { translateContainerPathViaMount } from '../host-path';

/** The destination's BACKUP/global flags for a given restic subcommand. Restore has its
 * OWN flags (threaded into the restore args by the restore builders), so this returns
 * NOTHING for a `restore` command - backup flags must never reach `restic restore`. */
function backupFlagsForCommand(destination: BackupDestination, command: string | undefined): string[] {
	if (command === 'restore') return [];
	return sanitizeResticFlags(parseBackupFlags(destination.flags).backup);
}

/**
 * For a LOCAL restic run (Dockhand host), restic's GCS backend needs a service-account
 * JSON FILE at GOOGLE_APPLICATION_CREDENTIALS. We carry the JSON as the env var
 * GOOGLE_APPLICATION_CREDENTIALS_JSON; this writes it to a private 0600 temp file,
 * points GOOGLE_APPLICATION_CREDENTIALS at it for the duration of `fn`, and deletes it
 * after. A no-op (fn(env) unchanged) when the var is absent, so non-GCS runs are untouched.
 * The helper-container path handles this itself in the shell script (gcsCredentialPreamble).
 */
export async function withGcsCredFile<T>(env: Record<string, string>, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
	const json = env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
	if (!json) return fn(env);
	const dir = mkdtempSync(join(tmpdir(), 'dockhand-gcs-'));
	const file = join(dir, 'sa.json');
	writeFileSync(file, json, { mode: 0o600 });
	try {
		return await fn({ ...env, GOOGLE_APPLICATION_CREDENTIALS: file });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * For a LOCAL restic run (Dockhand host), a self-signed TLS backend needs a CA FILE at
 * RESTIC_CACERT (and a client-cert PEM at RESTIC_TLS_CLIENT_CERT for mTLS). The certs are
 * stored as PEM CONTENT on the destination; this writes them to private 0600 temp files,
 * points the restic vars at them for the duration of `fn`, and deletes them after.
 * A no-op when the destination has no certs (fn(env) unchanged). The helper-container path
 * handles this itself in the shell script (tlsCertPreamble).
 */
export async function withTlsCertFiles<T>(
	certs: { cacert: string | null; clientCert: string | null },
	env: Record<string, string>,
	fn: (env: Record<string, string>) => Promise<T>
): Promise<T> {
	if (!certs.cacert && !certs.clientCert) return fn(env);
	const dir = mkdtempSync(join(tmpdir(), 'dockhand-tls-'));
	const runEnv = { ...env };
	if (certs.cacert) {
		const p = join(dir, 'ca.pem');
		writeFileSync(p, certs.cacert, { mode: 0o600 });
		runEnv.RESTIC_CACERT = p;
	}
	if (certs.clientCert) {
		const p = join(dir, 'client.pem');
		writeFileSync(p, certs.clientCert, { mode: 0o600 });
		runEnv.RESTIC_TLS_CLIENT_CERT = p;
	}
	try {
		return await fn(runEnv);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

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
 * Only the default: the `default_backup_image` setting always wins (see
 * ensureHelperImage()), so a user's own registry/tag is never overridden. */
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;
const HELPER_VARIANT_SUFFIX = process.env.DOCKHAND_VARIANT === 'baseline' ? '-baseline' : '';
export const DEFAULT_HELPER_IMAGE = APP_VERSION
	? `fnsys/dockhand-backup:${APP_VERSION}${HELPER_VARIANT_SUFFIX}`
	: `fnsys/dockhand-backup:latest${HELPER_VARIANT_SUFFIX}`;

export interface HelperRunSpec {
	/** The restic argv (without the leading `restic`). Optional: a script-mode spec
	 * (`script` set) ignores it. runInHelper defaults it to []. */
	args?: string[];
	/** Volume/bind mounts for the helper, e.g. `myvol:/volumes/myvol:ro`. */
	binds: string[];
	/** Target environment id (null/undefined = local Docker daemon). */
	envId?: number | null;
	/** Container name prefix - one name per operation, for cancel + reap. */
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
	/** Small in-RAM files (e.g. metadata.json) put-archived into the container BEFORE it
	 * starts. `path` is the full path from the container root. */
	metadataFiles?: MetadataFile[];
}

export class Restic {
	/**
	 * Run restic on the host. Resolves a ResticRun for EVERY outcome - a non-zero
	 * exit, a timeout (exitCode undefined + a signal), or a spawn error all come
	 * back as data, never as a thrown exception.
	 */
	async runLocal(
		destination: BackupDestination,
		args: string[],
		tier: TimeoutTier = 'interactive',
		/** Opt-in live output callbacks (chunk-level). restic writes `check`/`prune`
		 * progress to stderr; without these the output only arrives buffered after
		 * exit. */
		stream?: { onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void }
	): Promise<ResticRun> {
		const decrypted = decryptBackupDestination(destination);
		const env = buildResticEnv(process.env, {
			repository: destination.repository,
			password: decrypted.decryptedPassword,
			envVars: decrypted.decryptedEnvVars,
		});
		const fullArgs = [...args, ...backupFlagsForCommand(destination, args[0])];

		return withTlsCertFiles({ cacert: decrypted.decryptedCacert, clientCert: decrypted.decryptedTlsClientCert }, env, (tlsEnv) => withGcsCredFile(tlsEnv, (runEnv) => new Promise<ResticRun>((resolve) => {
			let stdout = '';
			let stderr = '';
			let settled = false;
			const done = (run: ResticRun) => { if (!settled) { settled = true; resolve(run); } };

			const proc = spawn('restic', fullArgs, { env: runEnv, timeout: TIMEOUTS[tier] });
			proc.stdout.on('data', (d) => { const s = String(d); stdout += s; stream?.onStdout?.(s); });
			proc.stderr.on('data', (d) => { const s = String(d); stderr += s; stream?.onStderr?.(s); });
			proc.on('close', (code, signal) => {
				const { exitCode, stderr: stderrOut } = classifyProcClose(code, signal, stderr);
				done({ exitCode, stdout, stderr: stderrOut });
			});
			proc.on('error', (err) => {
				// restic missing / not spawnable - a real failure, surfaced as data.
				const { exitCode, stderr: stderrOut } = classifyProcError(err, stderr);
				done({ exitCode, stdout, stderr: stderrOut });
			});
		})));
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
		const fullArgs = [...args, ...backupFlagsForCommand(destination, args[0])];

		return withTlsCertFiles({ cacert: decrypted.decryptedCacert, clientCert: decrypted.decryptedTlsClientCert }, env, (tlsEnv) => withGcsCredFile(tlsEnv, (runEnv) => new Promise((resolve) => {
			const chunks: Buffer[] = [];
			let stderr = '';
			let settled = false;
			const done = (run: { exitCode: number | undefined; stdout: Buffer; stderr: string }) => {
				if (!settled) { settled = true; resolve(run); }
			};

			const proc = spawn('restic', fullArgs, { env: runEnv, timeout: TIMEOUTS[tier] });
			proc.stdout.on('data', (d: Buffer) => { chunks.push(Buffer.from(d)); });
			proc.stderr.on('data', (d) => { stderr += d; });
			proc.on('close', (code, signal) => {
				const { exitCode, stderr: stderrOut } = classifyProcClose(code, signal, stderr);
				done({ exitCode, stdout: Buffer.concat(chunks), stderr: stderrOut });
			});
			proc.on('error', (err) => {
				const { exitCode, stderr: stderrOut } = classifyProcError(err, stderr);
				done({ exitCode, stdout: Buffer.concat(chunks), stderr: stderrOut });
			});
		})));
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
			filterCloudEnvVars(decrypted.decryptedEnvVars),
			{ cacert: decrypted.decryptedCacert, clientCert: decrypted.decryptedTlsClientCert }
		);
		const binds = buildHelperBinds(destination.repository, spec.binds, (repo) =>
			destination.hostPath || translateLocalRepoPath(repo)
		);
		const image = await ensureHelperImage(spec.envId);
		// Both paths append the exit marker so readExitMarker() sees the real exit
		// code. A caller-supplied script (e.g. the in-place restore swap) may use
		// `set -e`, so capture its exit in a subshell - the marker line must still
		// print on success, otherwise a clean run reads back as undefined (failure).
		// The local-repo guard runs FIRST (inside the marked command, so its exit 1
		// surfaces via the marker): a local repo whose `config` isn't visible on the
		// target daemon's host is a wrong-host mount - fail loud, not silently empty.
		const guard = localRepoGuard(destination.repository);
		// The helper runs as root; re-own a local repo to the main process's uid:gid
		// after the op so the main process (su-exec'd to that uid) can read it back.
		// Appended AFTER the exit marker so it never changes restic's exit code.
		const ownerSpec = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
		const chown = localRepoChown(destination.repository, ownerSpec);
		const argv = spec.args ?? [];
		// GCS: materialize the service-account JSON to a file + export
		// GOOGLE_APPLICATION_CREDENTIALS before restic runs (no-op for other backends).
		// Prepended inside the marked command so it shares restic's shell; covers every
		// helper op (backup/restore/swap) in one place.
		const gcs = gcsCredentialPreamble();
		// TLS: materialize a self-signed CA / client cert to a file + export RESTIC_CACERT /
		// RESTIC_TLS_CLIENT_CERT before restic runs (no-op when the destination has none).
		// Same shell as restic; covers every helper op. Works on a remote/Hawser daemon
		// because the PEM rides an env var, not a host bind.
		const tls = tlsCertPreamble();
		const cmd = spec.script
			? ['sh', '-c', finishScript(`( ${gcs}${tls}${guard}${spec.script} )`) + chown]
			: ['sh', '-c', finishScript(`${gcs}${tls}${guard}${resticCommand([...argv, ...backupFlagsForCommand(destination, argv[0])])}`) + chown];

		// The small metadata files (metadata.json + the light stack-dir listing) go into
		// the container via put-archive (docker cp), NOT the Cmd, so they can't blow
		// ARG_MAX. The stack dir's bytes ride a read-only host bind mount, not these files.
		const metadataFiles = spec.metadataFiles ?? [];
			const inlineEntries = metadataFiles.map((f) => ({ path: f.path.replace(/^\/+/, ''), content: Buffer.from(f.contentBase64, 'base64') }));
			const beforeStart = metadataFiles.length > 0
				? async (containerId: string) => {
					// Each file's `path` is the full path from the container root (e.g.
					// `metadata/metadata.json`), placing it under the right root.
					await putContainerArchive(containerId, '/', await buildTar(inlineEntries), spec.envId);
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
				// Forward live stdout lines to the spec's onStdout. The buffered `stdout`
				// above stays the source of truth for summary parsing (post-exit); this
				// only mirrors the same lines LIVE to the caller.
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
			// reporting a code) - an unknown outcome. Surface it as undefined-exit
			// data, never as a thrown error, so the caller fails closed.
			const message = err instanceof Error ? err.message : String(err);
			return { exitCode: undefined, stdout, stderr: `${stderr}\n${message}` };
		}
	}

}

/** Helper-image resolution timeouts (fail-fast so a stalled pull never hangs a
 * backup). Overridable for slow links / large images. */
const HELPER_INSPECT_TIMEOUT_MS = Number(process.env.BACKUP_HELPER_INSPECT_TIMEOUT ?? 20_000);
const HELPER_PULL_TIMEOUT_MS = Number(process.env.BACKUP_HELPER_PULL_TIMEOUT ?? 300_000);

/**
 * Resolve the helper image and ENSURE it is present on the target daemon (inspect-or-pull), with
 * fail-fast timeouts. Shared by the backup runner AND the config-time stack-dir probe - the probe
 * runs the same helper on the target daemon, so on an env that hasn't pulled the image yet (e.g. a
 * hawser agent) it must pull it too, or the probe fails with "No such image".
 */
// Short-TTL memo of "image is present on this env" so a burst of ensureHelperImage calls in one
// request (a restore preview probes N volumes) does ONE inspect, not N. Only a confirmed-present
// result is cached; a miss/pull is never cached, so a later-disappearing image is re-pulled after
// the TTL. Keyed by (image, envId).
const helperImagePresentUntil = new Map<string, number>();
const HELPER_IMAGE_MEMO_MS = 30_000;

export async function ensureHelperImage(envId?: number | null): Promise<string> {
	const image = (await getSetting('default_backup_image')) || DEFAULT_HELPER_IMAGE;
	const memoKey = `${image} ${envId ?? ''}`;
	const until = helperImagePresentUntil.get(memoKey);
	if (until && until > Date.now()) return image; // recently confirmed present on this env

	let exists = true;
	try {
		await withTimeout(inspectImage(image, envId ?? undefined), HELPER_INSPECT_TIMEOUT_MS,
			`timed out inspecting helper image "${image}"`);
	} catch (err: any) {
		if (err?.statusCode === 404) exists = false;
		else throw err;
	}
	if (!exists) {
		console.log(`[Backups] Pulling helper image: ${image}`);
		await withTimeout(pullImage(image, undefined, envId ?? undefined), HELPER_PULL_TIMEOUT_MS,
			`timed out pulling helper image "${image}" - check that it is available and the registry is reachable`);
	}
	helperImagePresentUntil.set(memoKey, Date.now() + HELPER_IMAGE_MEMO_MS);
	return image;
}

/** Translate an in-container repo path to its host path for the bind mount. */
function translateLocalRepoPath(repoPath: string): string {
	return translateContainerPathViaMount(repoPath) || repoPath;
}
