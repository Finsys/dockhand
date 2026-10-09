import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isSftpRepository } from '$lib/shared/sftp-repository';
import { shellQuote } from './restic-script';
import type { TarEntry } from './tar';

export interface SftpCredentials {
	privateKey: string | null;
	knownHosts: string | null;
}

export interface SftpCredentialFiles {
	privateKeyPath: string;
	knownHostsPath: string;
}

export const SFTP_HELPER_PRIVATE_KEY_FILE = '/tmp/dockhand-sftp/id';
export const SFTP_HELPER_KNOWN_HOSTS_FILE = '/tmp/dockhand-sftp/known_hosts';

export function normalizeSftpPrivateKey(privateKey: string): string {
	return `${privateKey.replace(/\r\n?/g, '\n').trimEnd()}\n`;
}

export function classifySftpKeygenExecutionError(error: NodeJS.ErrnoException): string {
	if (error.code === 'ETIMEDOUT') return 'SSH private key validation timed out';
	if (error.code === 'ENOENT') return 'SSH private key could not be validated because OpenSSH ssh-keygen is unavailable';
	return 'SSH private key could not be validated with OpenSSH';
}

/** The subset of spawnSync's result this validation reads. */
export interface KeygenResult {
	error?: NodeJS.ErrnoException;
	status?: number | null;
	stderr?: string;
}

/** Run ssh-keygen against a key file. Injectable so a test needs no OpenSSH present. */
export type RunKeygen = (privateKeyPath: string) => KeygenResult;

const runKeygenWithOpenSsh: RunKeygen = (privateKeyPath) =>
	spawnSync('ssh-keygen', ['-y', '-P', '', '-f', privateKeyPath], {
		encoding: 'utf8',
		timeout: 5000
	});

export function validateSftpPrivateKey(
	privateKey: string,
	writeFile: typeof writeFileSync = writeFileSync,
	runKeygen: RunKeygen = runKeygenWithOpenSsh
): string | null {
	const dir = mkdtempSync(join(tmpdir(), 'dockhand-sftp-key-'));
	try {
		const privateKeyPath = join(dir, 'id');
		writeFile(privateKeyPath, normalizeSftpPrivateKey(privateKey), { mode: 0o600 });
		const result = runKeygen(privateKeyPath);
		if (result.error) {
			return classifySftpKeygenExecutionError(result.error);
		}
		if (result.status === 0) return null;
		const stderr = (result.stderr ?? '').toLowerCase();
		if (stderr.includes('incorrect passphrase') || stderr.includes('bad passphrase')) {
			return 'SSH private key must not be passphrase-protected';
		}
		return 'SSH private key is invalid or unsupported by OpenSSH';
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function requireSftpCredentials(repository: string, credentials: SftpCredentials): void {
	if (!isSftpRepository(repository)) return;
	if (!credentials.privateKey?.trim()) throw new Error('SFTP destination is missing its SSH private key');
	if (!credentials.knownHosts?.trim()) throw new Error('SFTP destination is missing its verified SSH known_hosts data');
}

function buildSshArgs(files: SftpCredentialFiles): string {
	const args = [
		'-F', '/dev/null',
		'-i', files.privateKeyPath,
		'-o', `UserKnownHostsFile=${files.knownHostsPath}`,
		'-o', 'GlobalKnownHostsFile=/dev/null',
		'-o', 'StrictHostKeyChecking=yes',
		'-o', 'UpdateHostKeys=no',
		'-o', 'BatchMode=yes',
		'-o', 'NumberOfPasswordPrompts=0',
		'-o', 'PasswordAuthentication=no',
		'-o', 'KbdInteractiveAuthentication=no',
		'-o', 'PreferredAuthentications=publickey',
		'-o', 'IdentitiesOnly=yes',
		'-o', 'IdentityAgent=none',
		'-o', 'ForwardAgent=no',
	];
	return args.map(shellQuote).join(' ');
}

export function buildSftpResticOptionArgs(
	repository: string,
	files: SftpCredentialFiles | null
): string[] {
	if (!isSftpRepository(repository)) return [];
	if (!files) throw new Error('SFTP credential files were not materialized');
	return ['-o', `sftp.args=${buildSshArgs(files)}`];
}

export function sftpResticPreamble(
	repository: string,
	files: SftpCredentialFiles | null
): string {
	const args = buildSftpResticOptionArgs(repository, files);
	if (args.length === 0) return '';
	return `restic() { command restic ${args.map(shellQuote).join(' ')} "$@"; }; `;
}

export async function withSftpCredentialFiles<T>(
	repository: string,
	credentials: SftpCredentials,
	fn: (files: SftpCredentialFiles | null) => Promise<T>,
	writeFile: typeof writeFileSync = writeFileSync
): Promise<T> {
	if (!isSftpRepository(repository)) return fn(null);
	requireSftpCredentials(repository, credentials);

	const dir = mkdtempSync(join(tmpdir(), 'dockhand-sftp-'));
	try {
		const files = {
			privateKeyPath: join(dir, 'id'),
			knownHostsPath: join(dir, 'known_hosts'),
		};
		writeFile(files.privateKeyPath, normalizeSftpPrivateKey(credentials.privateKey!), { mode: 0o600 });
		writeFile(files.knownHostsPath, credentials.knownHosts!, { mode: 0o600 });
		return await fn(files);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export function buildSftpCredentialEntries(
	repository: string,
	credentials: SftpCredentials
): TarEntry[] {
	if (!isSftpRepository(repository)) return [];
	requireSftpCredentials(repository, credentials);
	return [
		{
			path: SFTP_HELPER_PRIVATE_KEY_FILE,
			content: Buffer.from(normalizeSftpPrivateKey(credentials.privateKey!), 'utf8'),
			mode: 0o600,
		},
		{
			path: SFTP_HELPER_KNOWN_HOSTS_FILE,
			content: Buffer.from(credentials.knownHosts!, 'utf8'),
			mode: 0o600,
		},
	];
}
