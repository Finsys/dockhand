import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpackTar } from 'modern-tar';
import {
	buildSftpRepository,
	isSftpRepository,
	parseSftpRepository,
	validateSftpCredentials,
	validateSftpRepository,
} from '../../src/lib/shared/sftp-repository';
import { validateRepositoryForSave } from '../../src/lib/server/backups/helpers';
import {
	buildSftpCredentialEntries,
	buildSftpResticOptionArgs,
	normalizeSftpPrivateKey,
	SFTP_HELPER_KNOWN_HOSTS_FILE,
	SFTP_HELPER_PRIVATE_KEY_FILE,
	sftpResticPreamble,
	validateSftpPrivateKey,
	withSftpCredentialFiles,
} from '../../src/lib/server/backups/sftp';
import { buildTar } from '../../src/lib/server/backups/tar';

const PRIVATE_KEY = generateKeyPairSync('rsa', {
	modulusLength: 1024,
	privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
	publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const KNOWN_HOSTS = '[backup.example.com]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnly\n';
const REPOSITORY = 'sftp://backup@backup.example.com:2222//srv/restic';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('SFTP repository syntax', () => {
	it('builds and parses a native SFTP URL with a custom port and absolute path', () => {
		const repository = buildSftpRepository({
			username: 'backup',
			host: 'backup.example.com',
			port: '2222',
			path: '/srv/restic',
		});
		assert.equal(repository, REPOSITORY);
		assert.deepEqual(parseSftpRepository(repository), {
			username: 'backup',
			host: 'backup.example.com',
			port: '2222',
			path: '/srv/restic',
		});
	});

	it('uses the default SSH port implicitly and preserves relative paths', () => {
		const repository = buildSftpRepository({
			username: 'backup',
			host: 'backup.example.com',
			port: '22',
			path: 'restic',
		});
		assert.equal(repository, 'sftp://backup@backup.example.com/restic');
		assert.equal(parseSftpRepository(repository)?.path, 'restic');
		assert.equal(parseSftpRepository(repository)?.port, '22');
	});

	it('uses the account home directory when the repository path is empty', () => {
		const repository = buildSftpRepository({
			username: 'backup',
			host: 'backup.example.com',
			port: '22',
			path: '',
		});
		assert.equal(repository, 'sftp://backup@backup.example.com/.');
		assert.equal(parseSftpRepository(repository)?.path, '');
		assert.equal(validateSftpRepository(repository), null);
		assert.equal(validateSftpRepository('sftp://backup@backup.example.com/'), null);
	});

	it('accepts restic traditional syntax, including domain-confined users', () => {
		assert.deepEqual(parseSftpRepository('sftp:user@domain@host:/repo'), {
			username: 'user@domain',
			host: 'host',
			port: '22',
			path: '/repo',
		});
	});

	it('rejects passwords, invalid ports, missing users, and tilde paths', () => {
		assert.match(validateSftpRepository('sftp://user:password@host/repo') ?? '', /passwords/);
		assert.notEqual(validateSftpRepository('sftp://user@host:99999/repo'), null);
		assert.match(validateSftpRepository('sftp://host/repo') ?? '', /username/);
		assert.match(validateSftpRepository('sftp:user@host:~/repo') ?? '', /instead of ~/);
	});

	it('is admitted by shared repository validation but still receives the host SSRF guard', () => {
		assert.equal(isSftpRepository(REPOSITORY), true);
		assert.equal(validateRepositoryForSave(REPOSITORY), null);
		assert.match(validateRepositoryForSave('sftp://backup@127.0.0.1:2222//srv/restic') ?? '', /not allowed/);
	});
});

describe('SFTP credential validation and edit semantics', () => {
	it('requires both the private key and verified known_hosts data on create', () => {
		assert.match(validateSftpCredentials({ repository: REPOSITORY }) ?? '', /private key/);
		assert.match(validateSftpCredentials({ repository: REPOSITORY, sshPrivateKey: PRIVATE_KEY }) ?? '', /known_hosts/);
		assert.equal(validateSftpCredentials({
			repository: REPOSITORY,
			sshPrivateKey: PRIVATE_KEY,
			sshKnownHosts: KNOWN_HOSTS,
		}), null);
	});

	it('supports keep and replace while rejecting a clear that would leave SFTP unverified', () => {
		assert.equal(validateSftpCredentials({
			repository: REPOSITORY,
			hasStoredSshPrivateKey: true,
			hasStoredSshKnownHosts: true,
		}), null);
		assert.equal(validateSftpCredentials({
			repository: REPOSITORY,
			sshPrivateKey: PRIVATE_KEY,
			sshKnownHosts: KNOWN_HOSTS,
			hasStoredSshPrivateKey: true,
			hasStoredSshKnownHosts: true,
		}), null);
		assert.match(validateSftpCredentials({
			repository: REPOSITORY,
			sshPrivateKey: '',
			hasStoredSshPrivateKey: true,
			hasStoredSshKnownHosts: true,
		}) ?? '', /private key/);
	});

	it('allows an explicit clear after switching to a non-SFTP backend', () => {
		assert.equal(validateSftpCredentials({
			repository: 's3:https://s3.example.com/bucket',
			sshPrivateKey: '',
			sshKnownHosts: '',
			hasStoredSshPrivateKey: true,
			hasStoredSshKnownHosts: true,
		}), null);
	});

	it('normalizes line endings and validates the key with OpenSSH', () => {
		const crlfWithoutFinalNewline = PRIVATE_KEY.trimEnd().replace(/\n/g, '\r\n');
		assert.equal(validateSftpPrivateKey(crlfWithoutFinalNewline), null);
		assert.equal(normalizeSftpPrivateKey(crlfWithoutFinalNewline), PRIVATE_KEY);
		assert.match(validateSftpPrivateKey(
			'-----BEGIN OPENSSH PRIVATE KEY-----\ninvalid\n-----END OPENSSH PRIVATE KEY-----'
		) ?? '', /invalid or unsupported/);
	});
});

describe('SFTP runtime credential materialization', () => {
	const createdPaths: string[] = [];
	afterEach(() => {
		for (const path of createdPaths.splice(0)) assert.equal(existsSync(path), false);
	});

	it('writes local credentials as 0600 files and removes them after use', async () => {
		await withSftpCredentialFiles(
			REPOSITORY,
			{ privateKey: PRIVATE_KEY, knownHosts: KNOWN_HOSTS },
			async (files) => {
				assert.notEqual(files, null);
				createdPaths.push(files!.privateKeyPath, files!.knownHostsPath);
				assert.equal(statSync(files!.privateKeyPath).mode & 0o777, 0o600);
				assert.equal(statSync(files!.knownHostsPath).mode & 0o777, 0o600);
				assert.equal(readFileSync(files!.privateKeyPath, 'utf8'), PRIVATE_KEY);
				assert.equal(readFileSync(files!.knownHostsPath, 'utf8'), KNOWN_HOSTS);
			}
		);
	});

	it('builds strict public-key-only SSH options without embedding credential contents', () => {
		const args = buildSftpResticOptionArgs(REPOSITORY, {
			privateKeyPath: '/tmp/key',
			knownHostsPath: '/tmp/known_hosts',
		});
		const rendered = args.join(' ');
		assert.ok(rendered.includes('StrictHostKeyChecking=yes'));
		assert.ok(rendered.includes('UserKnownHostsFile=/tmp/known_hosts'));
		assert.ok(rendered.includes('GlobalKnownHostsFile=/dev/null'));
		assert.ok(rendered.includes('PasswordAuthentication=no'));
		assert.ok(rendered.includes('KbdInteractiveAuthentication=no'));
		assert.ok(rendered.includes('IdentityAgent=none'));
		assert.ok(rendered.includes('ForwardAgent=no'));
		assert.ok(!rendered.includes('StrictHostKeyChecking=no'));
		assert.ok(!rendered.includes(PRIVATE_KEY));
		assert.ok(!rendered.includes(KNOWN_HOSTS));
	});

	it('injects the same options into every scripted helper restic call', () => {
		const preamble = sftpResticPreamble(REPOSITORY, {
			privateKeyPath: SFTP_HELPER_PRIVATE_KEY_FILE,
			knownHostsPath: SFTP_HELPER_KNOWN_HOSTS_FILE,
		});
		assert.ok(preamble.includes('restic() { command restic'));
		assert.ok(preamble.includes('StrictHostKeyChecking=yes'));
		assert.ok(preamble.includes('"$@"'));
	});

	it('packs helper credentials with 0600 modes and no environment-value indirection', async () => {
		const entries = buildSftpCredentialEntries(REPOSITORY, {
			privateKey: PRIVATE_KEY,
			knownHosts: KNOWN_HOSTS,
		});
		assert.deepEqual(entries.map((entry) => entry.path), [
			SFTP_HELPER_PRIVATE_KEY_FILE,
			SFTP_HELPER_KNOWN_HOSTS_FILE,
		]);
		const unpacked = await unpackTar(await buildTar(entries, 1000));
		assert.deepEqual(unpacked.map((entry) => entry.header.mode), [0o600, 0o600]);
	});

	it('is a no-op for non-SFTP repositories', async () => {
		await withSftpCredentialFiles(
			's3:https://s3.example.com/bucket',
			{ privateKey: null, knownHosts: null },
			async (files) => assert.equal(files, null)
		);
		assert.deepEqual(buildSftpCredentialEntries(
			's3:https://s3.example.com/bucket',
			{ privateKey: null, knownHosts: null }
		), []);
	});
});

describe('SFTP secret persistence and response surfaces', () => {
	it('allows extensionless OpenSSH key and known_hosts files in the upload picker', () => {
		const modalSource = readFileSync(join(root, 'src/routes/settings/backups/DestinationModal.svelte'), 'utf8');
		assert.match(modalSource, /accept=\{field\.accept\}/);
		assert.doesNotMatch(modalSource, /accept:\s*['"][^'"]*(?:\.pem|\.known_hosts)/);
	});

	it('shows stored-secret guidance and uses the SFTP server icon', () => {
		const modalSource = readFileSync(join(root, 'src/routes/settings/backups/DestinationModal.svelte'), 'utf8');
		const backupUtils = readFileSync(join(root, 'src/lib/utils/backup.ts'), 'utf8');
		assert.match(modalSource, /an SSH private key is stored — leave blank to keep it/);
		assert.match(backupUtils, /repository\.startsWith\('sftp:'\)\) return Server/);
	});

	it('encrypts both dedicated fields and exposes only has... flags through APIs', () => {
		const dbSource = readFileSync(join(root, 'src/lib/server/db.ts'), 'utf8');
		assert.match(dbSource, /sshPrivateKey:\s*data\.sshPrivateKey\s*\?\s*encrypt\(data\.sshPrivateKey\)/);
		assert.match(dbSource, /sshKnownHosts:\s*data\.sshKnownHosts\s*\?\s*encrypt\(data\.sshKnownHosts\)/);
		assert.match(dbSource, /decryptStrict\(dest\.sshPrivateKey\)/);
		assert.match(dbSource, /decryptStrict\(dest\.sshKnownHosts\)/);

		for (const route of [
			'src/routes/api/backup/destinations/+server.ts',
			'src/routes/api/backup/destinations/[id]/+server.ts',
		]) {
			const source = readFileSync(join(root, route), 'utf8');
			assert.match(source, /hasSshPrivateKey/);
			assert.match(source, /hasSshKnownHosts/);
			assert.match(source, /delete result\.sshPrivateKey/);
			assert.match(source, /delete result\.sshKnownHosts/);
		}
	});

	it('ships OpenSSH in both helper variants and both database migrations', () => {
		assert.match(readFileSync(join(root, 'Dockerfile.backup'), 'utf8'), /openssh-client/);
		assert.match(readFileSync(join(root, 'Dockerfile.backup.baseline'), 'utf8'), /openssh-client/);
		for (const migration of [
			'drizzle/0019_add_backup_sftp.sql',
			'drizzle-pg/0019_add_backup_sftp.sql',
		]) {
			const source = readFileSync(join(root, migration), 'utf8');
			assert.match(source, /ssh_private_key/);
			assert.match(source, /ssh_known_hosts/);
		}
	});
});
