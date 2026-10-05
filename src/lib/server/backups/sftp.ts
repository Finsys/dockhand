import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

export function validateSftpPrivateKey(privateKey: string): string | null {
	const dir = mkdtempSync(join(tmpdir(), 'dockhand-sftp-key-'));
	chmodSync(dir, 0o700);
	const privateKeyPath = join(dir, 'id');
	writeFileSync(privateKeyPath, normalizeSftpPrivateKey(privateKey), { mode: 0o600 });
	try {
		const result = spawnSync('ssh-keygen', ['-y', '-P', '', '-f', privateKeyPath], {
			encoding: 'utf8',
			timeout: 5000,
		});
		if (result.error) {
			return result.error.name === 'ETIMEDOUT'
				? 'SSH private key validation timed out'
				: 'SSH private key could not be validated with OpenSSH';
		}
		if (result.status === 0) return null;
		const stderr = result.stderr.toLowerCase();
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
	const privateKeyError = validateSftpPrivateKey(credentials.privateKey);
	if (privateKeyError) throw new Error(privateKeyError);
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
	fn: (files: SftpCredentialFiles | null) => Promise<T>
): Promise<T> {
	if (!isSftpRepository(repository)) return fn(null);
	requireSftpCredentials(repository, credentials);

	const dir = mkdtempSync(join(tmpdir(), 'dockhand-sftp-'));
	chmodSync(dir, 0o700);
	const files = {
		privateKeyPath: join(dir, 'id'),
		knownHostsPath: join(dir, 'known_hosts'),
	};
	writeFileSync(files.privateKeyPath, normalizeSftpPrivateKey(credentials.privateKey!), { mode: 0o600 });
	writeFileSync(files.knownHostsPath, credentials.knownHosts!, { mode: 0o600 });
	try {
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
