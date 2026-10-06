export interface SftpRepositoryConfig {
	username: string;
	host: string;
	port: string;
	path: string;
}

export interface SftpCredentialValidationInput {
	repository: string;
	sshPrivateKey?: unknown;
	sshKnownHosts?: unknown;
	hasStoredSshPrivateKey?: boolean;
	hasStoredSshKnownHosts?: boolean;
}

const MAX_SFTP_CREDENTIAL_BYTES = 1024 * 1024;
const PRIVATE_KEY_HEADER = /-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/;
const textEncoder = new TextEncoder();

export function isSftpRepository(repository: string | null | undefined): boolean {
	return typeof repository === 'string' && repository.trim().startsWith('sftp:');
}

function decodeUrlPart(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

function stripIpv6Brackets(host: string): string {
	return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export function parseSftpRepository(repository: string): SftpRepositoryConfig | null {
	const repo = repository.trim();
	if (!repo.startsWith('sftp:')) return null;

	if (repo.startsWith('sftp://')) {
		let url: URL;
		try {
			url = new URL(repo);
		} catch {
			return null;
		}
		if (url.protocol !== 'sftp:' || url.password || url.search || url.hash) return null;
		const username = decodeUrlPart(url.username);
		const path = decodeUrlPart(url.pathname.slice(1));
		if (username === null || path === null) return null;
		return {
			username,
			host: stripIpv6Brackets(url.hostname),
			port: url.port || '22',
			path,
		};
	}

	const remainder = repo.slice('sftp:'.length);
	const pathSeparator = remainder.indexOf(':');
	if (pathSeparator < 0) return null;
	const authority = remainder.slice(0, pathSeparator);
	const path = remainder.slice(pathSeparator + 1);
	const userSeparator = authority.lastIndexOf('@');
	if (userSeparator <= 0) return null;
	return {
		username: authority.slice(0, userSeparator),
		host: authority.slice(userSeparator + 1),
		port: '22',
		path,
	};
}

export function validateSftpRepository(repository: string): string | null {
	if (!isSftpRepository(repository)) return null;
	if (repository !== repository.trim()) {
		return 'Invalid SFTP repository: leading or trailing whitespace is not allowed';
	}
	if (repository.startsWith('sftp://')) {
		try {
			const url = new URL(repository);
			if (url.password) return 'Invalid SFTP repository: passwords in the repository URL are not allowed';
			if (url.search || url.hash) return 'Invalid SFTP repository: query strings and fragments are not allowed';
		} catch {
			return 'Invalid SFTP repository URL';
		}
	}

	const parsed = parseSftpRepository(repository);
	if (!parsed) {
		return 'Invalid SFTP repository: use sftp:user@host:/path or sftp://user@host:port//path';
	}
	if (!parsed.username.trim()) return 'Invalid SFTP repository: an SSH username is required';
	if (!parsed.host.trim() || /\s/.test(parsed.host)) return 'Invalid SFTP repository: a valid SSH host is required';
	const port = Number(parsed.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		return 'Invalid SFTP repository: SSH port must be between 1 and 65535';
	}
	if (parsed.path.startsWith('~')) {
		return 'Invalid SFTP repository: use a relative path or an absolute path instead of ~';
	}
	return null;
}

function encodePath(path: string): string {
	return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

export function buildSftpRepository(fields: Partial<SftpRepositoryConfig>): string {
	const username = encodeURIComponent(fields.username?.trim() || '');
	const rawHost = stripIpv6Brackets(fields.host?.trim() || '');
	const host = rawHost.includes(':') ? `[${rawHost}]` : rawHost;
	const port = fields.port?.trim() || '22';
	const portPart = port === '22' ? '' : `:${port}`;
	const path = encodePath(fields.path?.trim() || '.');
	return `sftp://${username}@${host}${portPart}/${path}`;
}

function suppliedSecret(value: unknown, stored: boolean): { present: boolean; invalidType: boolean; text: string } {
	if (value === undefined) return { present: stored, invalidType: false, text: '' };
	if (typeof value !== 'string') return { present: false, invalidType: true, text: '' };
	return { present: value.trim().length > 0, invalidType: false, text: value };
}

export function validateSftpCredentials(input: SftpCredentialValidationInput): string | null {
	const privateKey = suppliedSecret(input.sshPrivateKey, !!input.hasStoredSshPrivateKey);
	const knownHosts = suppliedSecret(input.sshKnownHosts, !!input.hasStoredSshKnownHosts);
	if (privateKey.invalidType) return 'SSH private key must be text';
	if (knownHosts.invalidType) return 'SSH known_hosts data must be text';
	if (!isSftpRepository(input.repository)) return null;
	if (!privateKey.present) return 'SFTP destinations require an SSH private key';
	if (!knownHosts.present) return 'SFTP destinations require verified SSH known_hosts data';

	if (privateKey.text) {
		if (textEncoder.encode(privateKey.text).byteLength > MAX_SFTP_CREDENTIAL_BYTES) {
			return 'SSH private key is too large';
		}
		if (privateKey.text.includes('\0')) return 'SSH private key must not contain NUL bytes';
		if (!PRIVATE_KEY_HEADER.test(privateKey.text)) return 'SSH private key is not a recognized private-key PEM';
	}
	if (knownHosts.text) {
		if (textEncoder.encode(knownHosts.text).byteLength > MAX_SFTP_CREDENTIAL_BYTES) {
			return 'SSH known_hosts data is too large';
		}
		if (knownHosts.text.includes('\0')) return 'SSH known_hosts data must not contain NUL bytes';
		const entries = knownHosts.text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith('#'));
		if (entries.length === 0 || entries.some((line) => line.split(/\s+/).length < 3)) {
			return 'SSH known_hosts data must contain at least one valid host-key entry';
		}
	}
	return null;
}
