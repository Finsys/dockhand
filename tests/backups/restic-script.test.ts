/**
 * Unit tests for backups/restic-script.ts — the pure shell-command builders and
 * exit-marker reader used by the restic helper container path. No mocks.
 */
import { describe, it, expect } from 'bun:test';
import {
	EXIT_MARKER,
	shellQuote,
	resticCommand,
	finishScript,
	readExitMarker,
	buildHelperEnv,
	buildHelperBinds,
	localRepoGuard,
	localRepoChown,
	classifyProcClose,
	classifyProcError,
	gcsCredentialPreamble,
	GCS_CRED_FILE,
	tlsCertPreamble,
	CACERT_FILE,
	TLS_CLIENT_FILE,
} from '../../src/lib/server/backups/restic-script';

describe('shellQuote', () => {
	it('wraps a plain string in single quotes', () => {
		expect(shellQuote('data')).toBe(`'data'`);
	});
	it('escapes embedded single quotes (no shell injection)', () => {
		expect(shellQuote(`a'b`)).toBe(`'a'\\''b'`);
	});
	it('neutralises shell metacharacters by quoting', () => {
		expect(shellQuote('$(rm -rf /)')).toBe(`'$(rm -rf /)'`);
		expect(shellQuote('a; b')).toBe(`'a; b'`);
	});
});

describe('resticCommand', () => {
	it('builds a restic command with every arg quoted', () => {
		expect(resticCommand(['backup', '/volumes/', '--tag', 'x'])).toBe(
			`restic 'backup' '/volumes/' '--tag' 'x'`
		);
	});
	it('quotes an arg that contains a single quote', () => {
		expect(resticCommand(['--host', `o'brien`])).toBe(`restic '--host' 'o'\\''brien'`);
	});
});

describe('finishScript + readExitMarker (surface the REAL restic exit code)', () => {
	it('appends the exit marker capturing $?', () => {
		const s = finishScript(`restic 'backup'`);
		expect(s).toContain('restic \'backup\';');
		expect(s).toContain('__rc=$?');
		expect(s).toContain(`echo "${EXIT_MARKER}`);
	});

	it('reads the exit code from the marker line', () => {
		expect(readExitMarker(`some output\n${EXIT_MARKER}0`)).toBe(0);
		expect(readExitMarker(`${EXIT_MARKER}3`)).toBe(3); // partial-backup code preserved
		expect(readExitMarker(`x\n${EXIT_MARKER}1\ny`)).toBe(1);
	});

	it('reads the LAST marker when output has trailing lines', () => {
		expect(readExitMarker(`${EXIT_MARKER}1\ntrailing\n${EXIT_MARKER}0`)).toBe(0);
	});

	// A caller-supplied script (e.g. the in-place restore swap) uses `set -e`.
	// Wrapping it as `finishScript('( <script> )')` must still emit the marker so
	// a clean run isn't misread as a failure (no marker → undefined exit → error).
	it('captures a set -e script exit via the marker (no false failure on success)', () => {
		const swap = 'set -e; echo recover; echo restic; echo swap';
		const cmd = finishScript(`( ${swap} )`);
		expect(cmd).toContain('__rc=$?');
		expect(cmd).toContain(`echo "${EXIT_MARKER}`);
		// A successful run prints its output then the marker with 0.
		expect(readExitMarker(`recover\nrestic\nswap\n${EXIT_MARKER}0`)).toBe(0);
		// A set -e abort mid-script surfaces the real non-zero code.
		expect(readExitMarker(`recover\n${EXIT_MARKER}1`)).toBe(1);
	});

	it('returns undefined when the marker is absent (killed/crashed ⇒ unknown outcome)', () => {
		expect(readExitMarker('restic ran but was killed mid-output')).toBeUndefined();
		expect(readExitMarker('')).toBeUndefined();
	});

	it('returns undefined for a malformed marker value', () => {
		expect(readExitMarker(`${EXIT_MARKER}notanumber`)).toBeUndefined();
	});

	// Prove the shell contract in a REAL shell: finishScript preserves a
	// command's exit code as the marker value AND the wrapper itself exits 0
	// (so the docker layer never sees a "failed" container for a mere restic
	// non-zero). We run the generated script by writing it to a temp file to
	// avoid any nested-quoting hazard.
	function runFinished(command: string): { markerCode: number | undefined; wrapperExit: number } {
		const { execFileSync } = require('child_process');
		const { mkdtempSync, writeFileSync, rmSync } = require('fs');
		const { tmpdir } = require('os');
		const { join } = require('path');
		const dir = mkdtempSync(join(tmpdir(), 'restic-script-'));
		const file = join(dir, 'run.sh');
		writeFileSync(file, finishScript(command));
		try {
			let wrapperExit = 0;
			let out = '';
			try {
				out = execFileSync('sh', [file], { encoding: 'utf8' });
			} catch (e: any) {
				wrapperExit = e.status ?? 1;
				out = e.stdout ?? '';
			}
			return { markerCode: readExitMarker(out), wrapperExit };
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// Use a subshell `(exit N)` — like restic, it RETURNS a non-zero status
	// without terminating the wrapper shell (a bare `exit N` would end the whole
	// script before the marker prints; restic never does that).
	it('a command returning 3 is reported as 3, and the wrapper still exits 0', () => {
		const { markerCode, wrapperExit } = runFinished('(exit 3)');
		expect(markerCode).toBe(3);
		expect(wrapperExit).toBe(0); // docker layer must NOT see this as a crash
	});

	it('a successful command yields marker 0, wrapper 0', () => {
		expect(runFinished('true')).toEqual({ markerCode: 0, wrapperExit: 0 });
	});

	it('a command returning 1 is reported as 1, wrapper still 0', () => {
		expect(runFinished('(exit 1)')).toEqual({ markerCode: 1, wrapperExit: 0 });
	});
});

// The dump path (dumpSnapshotFileBytes / dumpSnapshotArchive) captures restic's
// stdout with Buffer.concat rather than string concatenation. This asserts the
// underlying contract that makes that fix correct: appending Buffer chunks to a
// JS string mangles non-UTF-8 bytes (each → U+FFFD, and multibyte sequences split
// across chunks), while Buffer.concat is lossless. binary.bin in the integration
// suite uses exactly these bytes.
describe('binary stdout capture — Buffer.concat is lossless where string concat is not', () => {
	const SENTINEL = Buffer.from([0xff, 0xfe, 0x00, 0x81, 0x82]);

	it('Buffer.concat preserves every byte across chunk boundaries', () => {
		// Simulate two data events splitting the sentinel mid-stream.
		const chunks = [SENTINEL.subarray(0, 2), SENTINEL.subarray(2)];
		const joined = Buffer.concat(chunks);
		expect(Array.from(joined)).toEqual([0xff, 0xfe, 0x00, 0x81, 0x82]);
	});

	it('the old string-concat path corrupts the same bytes (regression rationale)', () => {
		// `stdout += d` coerces each Buffer to a UTF-8 string; re-encoding loses the
		// original bytes. This is the bug the binary path fixes.
		let s = '';
		s += SENTINEL.subarray(0, 2);
		s += SENTINEL.subarray(2);
		const roundTripped = Array.from(Buffer.from(s, 'utf8'));
		expect(roundTripped).not.toEqual([0xff, 0xfe, 0x00, 0x81, 0x82]);
	});
});

describe('buildHelperEnv', () => {
	it('sets repo, password, progress, plus allowlisted cloud vars', () => {
		const env = buildHelperEnv('s3:bucket', 'pw', { AWS_ACCESS_KEY_ID: 'k' });
		expect(env).toContain('RESTIC_REPOSITORY=s3:bucket');
		expect(env).toContain('RESTIC_PASSWORD=pw');
		expect(env).toContain('RESTIC_PROGRESS_FPS=2');
		expect(env).toContain('AWS_ACCESS_KEY_ID=k');
	});
	it('is caller-filtered — it does NOT re-filter, so pass the allowlisted map', () => {
		// The caller passes filterCloudEnvVars(...); this fn trusts that. Given an
		// empty map, no cloud vars are added.
		const env = buildHelperEnv('r', 'p', {});
		expect(env).toHaveLength(3);
	});
	it('adds the TLS PEM content vars when certs are supplied', () => {
		const env = buildHelperEnv('rest:https://x/repo', 'p', {}, { cacert: 'CA-PEM', clientCert: 'CLIENT-PEM' });
		expect(env).toContain('RESTIC_CACERT_PEM=CA-PEM');
		expect(env).toContain('RESTIC_TLS_CLIENT_CERT_PEM=CLIENT-PEM');
	});
	it('adds only the certs that are present (independent of each other)', () => {
		const caOnly = buildHelperEnv('r', 'p', {}, { cacert: 'CA', clientCert: null });
		expect(caOnly).toContain('RESTIC_CACERT_PEM=CA');
		expect(caOnly.some((e) => e.startsWith('RESTIC_TLS_CLIENT_CERT_PEM='))).toBe(false);
	});
	it('adds no cert vars when tls is omitted (no-op for non-TLS backends)', () => {
		const env = buildHelperEnv('s3:bucket', 'p', { AWS_ACCESS_KEY_ID: 'k' });
		expect(env.some((e) => e.startsWith('RESTIC_CACERT_PEM='))).toBe(false);
		expect(env.some((e) => e.startsWith('RESTIC_TLS_CLIENT_CERT_PEM='))).toBe(false);
	});
});

describe('buildHelperBinds', () => {
	const resolve = (p: string) => `/host${p}`;
	it('passes volume binds through unchanged for a remote repo', () => {
		const binds = buildHelperBinds('s3:bucket', ['vol:/volumes/vol:ro'], resolve);
		expect(binds).toEqual(['vol:/volumes/vol:ro']);
	});
	it('adds the repo path bind for a local (filesystem) repo', () => {
		const binds = buildHelperBinds('/srv/restic', ['vol:/volumes/vol:ro'], resolve);
		expect(binds).toEqual(['vol:/volumes/vol:ro', '/host/srv/restic:/srv/restic']);
	});
	it('does not mutate the caller array', () => {
		const input = ['a:/volumes/a:ro'];
		buildHelperBinds('/srv/restic', input, resolve);
		expect(input).toEqual(['a:/volumes/a:ro']);
	});
});

describe('localRepoGuard (#1316 fail-loud on wrong-host mount)', () => {
	it('emits a config-existence check for a local (filesystem) repo', () => {
		const g = localRepoGuard('/mnt/nas/backups');
		expect(g).toContain('test -f "$RESTIC_REPOSITORY/config"');
		expect(g).toContain('exit 1');
		expect(g.endsWith('; ')).toBe(true); // trailing separator so it prefixes the restic command cleanly
	});
	it('emits nothing for a cloud / rest repo (no path is bound)', () => {
		expect(localRepoGuard('s3:s3.amazonaws.com/bucket')).toBe('');
		expect(localRepoGuard('rest:http://host:8000/')).toBe('');
		expect(localRepoGuard('b2:bucket:path')).toBe('');
	});
	it('a relative ./ path is NOT local (matches the save gate)', () => {
		// A relative ./ path is NOT local: isAllowedRepository (the single save gate) accepts
		// only absolute local paths, and all local-repo sites share isLocalRepo now, so guard
		// agrees - no path bound/guarded for a ./ repo.
		expect(localRepoGuard('./data/repo')).toBe('');
	});
});

describe('localRepoChown (helper writes repo as root; re-own for the main uid)', () => {
	it('emits a recursive chown to the given owner for a local repo', () => {
		const c = localRepoChown('/mnt/nas/backups', '1001:1001');
		expect(c).toContain('chown -R 1001:1001 "$RESTIC_REPOSITORY"');
		expect(c).toContain('|| true'); // best-effort: never fails the backup
		expect(c.startsWith('; ')).toBe(true); // appends AFTER the exit marker
	});
	it('a relative ./ path is NOT local (matches the save gate)', () => {
		// ./ is not local (see localRepoGuard above) - no repo files to chown for it.
		expect(localRepoChown('./data/repo', '1000:1000')).toBe('');
	});
	it('emits nothing for a cloud / rest repo (no local files to own)', () => {
		expect(localRepoChown('s3:s3.amazonaws.com/bucket', '1001:1001')).toBe('');
		expect(localRepoChown('rest:http://host:8000/', '1001:1001')).toBe('');
		expect(localRepoChown('b2:bucket:path', '1001:1001')).toBe('');
	});
	it('emits nothing when ownerSpec is empty (uid unknown)', () => {
		expect(localRepoChown('/mnt/nas/backups', '')).toBe('');
	});
	it('PUID=0 (root) chowns to 0:0 — a harmless no-op on an already-root repo', () => {
		expect(localRepoChown('/mnt/nas/backups', '0:0')).toContain('chown -R 0:0');
	});
});

// The fail-closed exit/stderr mapping the runLocal / runLocalBinary spawn callbacks use.
// The critical property: a clean exit is the ONLY thing that yields a defined exitCode;
// a timeout kill (code null + signal) and a spawn error both map to undefined = failure,
// so an unknown outcome is never mistaken for success.
describe('classifyProcClose (spawn close → fail-closed exit/stderr)', () => {
	it('a clean exit 0 is exitCode 0, stderr unchanged', () => {
		expect(classifyProcClose(0, null, 'warnings')).toEqual({ exitCode: 0, stderr: 'warnings' });
	});
	it('a non-zero exit is preserved (e.g. restic 3 = partial)', () => {
		expect(classifyProcClose(3, null, '')).toEqual({ exitCode: 3, stderr: '' });
		expect(classifyProcClose(1, null, 'err')).toEqual({ exitCode: 1, stderr: 'err' });
	});
	it('code === null (timeout kill) → undefined exit (unknown outcome = failure)', () => {
		const r = classifyProcClose(null, 'SIGTERM', 'partial output');
		expect(r.exitCode).toBeUndefined();
	});
	it('a killing signal is appended to stderr so it is visible', () => {
		const r = classifyProcClose(null, 'SIGKILL', 'before-kill');
		expect(r.stderr).toBe('before-kill\n(process killed by SIGKILL)');
	});
	it('no signal leaves stderr untouched (no spurious "killed by" line)', () => {
		expect(classifyProcClose(0, null, 'x').stderr).toBe('x');
	});
});

describe('classifyProcError (spawn error → fail-closed data, never a throw)', () => {
	it('a spawn error (restic missing) is undefined exit with the message appended', () => {
		const r = classifyProcError(new Error('spawn restic ENOENT'), 'prior stderr');
		expect(r.exitCode).toBeUndefined();
		expect(r.stderr).toBe('prior stderr\nspawn restic ENOENT');
	});
	it('appends onto empty stderr cleanly', () => {
		expect(classifyProcError(new Error('boom'), '').stderr).toBe('\nboom');
	});
});

describe('gcsCredentialPreamble', () => {
	const p = gcsCredentialPreamble();
	it('is guarded on the JSON var being non-empty (no-op for other backends)', () => {
		// The whole thing is inside `if [ -n "${GOOGLE_APPLICATION_CREDENTIALS_JSON:-}" ]`,
		// so an S3/B2/Azure/local run (var unset) does nothing.
		expect(p).toContain('if [ -n "${GOOGLE_APPLICATION_CREDENTIALS_JSON:-}" ]');
		expect(p.trim().endsWith('fi;')).toBe(true);
	});
	it('writes the JSON to the private cred file and exports the path', () => {
		expect(p).toContain(`printf '%s' "$GOOGLE_APPLICATION_CREDENTIALS_JSON" > ${GCS_CRED_FILE}`);
		expect(p).toContain(`export GOOGLE_APPLICATION_CREDENTIALS=${GCS_CRED_FILE}`);
	});
	it('sets a restrictive umask so the cred file is not world-readable', () => {
		expect(p).toContain('umask 077');
	});
	it('ends with a separator so it can be prepended before the next command', () => {
		expect(p.endsWith('; ')).toBe(true);
	});
});

describe('tlsCertPreamble (self-signed TLS backend: CA + client cert)', () => {
	const p = tlsCertPreamble();
	it('guards each cert on its own env var (no-op for plaintext/public-CA backends)', () => {
		// Both branches are inside `if [ -n "${...:-}" ]`, so a run with neither var set
		// does nothing - S3/local/public-HTTPS repos are untouched.
		expect(p).toContain('if [ -n "${RESTIC_CACERT_PEM:-}" ]');
		expect(p).toContain('if [ -n "${RESTIC_TLS_CLIENT_CERT_PEM:-}" ]');
	});
	it('writes the CA PEM to the private file and points RESTIC_CACERT at it', () => {
		expect(p).toContain(`printf '%s' "$RESTIC_CACERT_PEM" > ${CACERT_FILE}`);
		expect(p).toContain(`export RESTIC_CACERT=${CACERT_FILE}`);
	});
	it('writes the client PEM to the private file and points RESTIC_TLS_CLIENT_CERT at it', () => {
		expect(p).toContain(`printf '%s' "$RESTIC_TLS_CLIENT_CERT_PEM" > ${TLS_CLIENT_FILE}`);
		expect(p).toContain(`export RESTIC_TLS_CLIENT_CERT=${TLS_CLIENT_FILE}`);
	});
	it('sets a restrictive umask so neither cert file is world-readable', () => {
		expect(p.match(/umask 077/g)?.length).toBe(2);
	});
	it('ends with a separator so it can be prepended before the next command', () => {
		expect(p.endsWith('; ')).toBe(true);
	});
});
