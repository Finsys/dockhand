/**
 * Secrets File Parser Module
 *
 * Parses .secrets.yaml files from Git stacks to determine which secrets
 * to fetch from HashiCorp Vault.
 */

import yaml from 'js-yaml';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Configuration from a .secrets.yaml file
 */
export interface SecretsFileConfig {
	vault?: {
		address?: string;
		namespace?: string;
		path?: string;
		auth?: {
			method?: 'token' | 'approle' | 'kubernetes';
			role_id?: string;
			secret_id?: string;
			token?: string;
			kube_role?: string;
		};
		/**
		 * Global default: trigger redeploy when any secret changes
		 * Default: false
		 */
		triggerRedeploy?: boolean;
	};
	secrets: SecretDefinition[];
}

/**
 * A single secret definition
 */
export interface SecretDefinition {
	/**
	 * Environment variable name in the stack
	 */
	name: string;

	/**
	 * Key in Vault (relative to vault.path unless path is specified)
	 */
	key?: string;

	/**
	 * Full Vault path (overrides vault.path)
	 */
	path?: string;

	/**
	 * Trigger stack redeploy when this secret changes
	 * Overrides vault.triggerRedeploy if set
	 */
	triggerRedeploy?: boolean;
}

/**
 * Parsed and normalized secret configuration
 */
export interface ParsedSecretsConfig {
	/**
	 * Vault path prefix (e.g., "secret/data/myapp")
	 */
	vaultPath: string;

	/**
	 * Optional Vault address override
	 */
	vaultAddress?: string;

	/**
	 * Optional Vault namespace override
	 */
	vaultNamespace?: string;

	/**
	 * Optional auth method override
	 */
	authOverride?: {
		method: 'token' | 'approle' | 'kubernetes';
		roleId?: string;
		secretId?: string;
		token?: string;
		kubeRole?: string;
	};

	/**
	 * Secrets to fetch, grouped by Vault path
	 */
	secretsByPath: Map<string, SecretMapping[]>;

	/**
	 * Global default for triggerRedeploy (from vault.triggerRedeploy)
	 */
	triggerRedeployDefault: boolean;
}

/**
 * Mapping from Vault key to environment variable name
 */
export interface SecretMapping {
	/**
	 * Environment variable name
	 */
	envVar: string;

	/**
	 * Key name in Vault
	 */
	vaultKey: string;

	/**
	 * Whether changes to this secret should trigger a stack redeploy
	 */
	triggerRedeploy: boolean;
}

// =============================================================================
// SUPPORTED FILE NAMES
// =============================================================================

const SECRETS_FILE_NAMES = [
	'.secrets.yaml',
	'.secrets.yml',
	'secrets.yaml',
	'secrets.yml'
];

// =============================================================================
// PARSER FUNCTIONS
// =============================================================================

/**
 * Find a secrets file in a stack directory
 */
export function findSecretsFile(stackDir: string): string | null {
	for (const fileName of SECRETS_FILE_NAMES) {
		const filePath = join(stackDir, fileName);
		if (existsSync(filePath)) {
			return filePath;
		}
	}
	return null;
}

/**
 * Parse a .secrets.yaml file content
 */
export function parseSecretsFile(content: string): SecretsFileConfig {
	const parsed = yaml.load(content) as any;

	if (!parsed || typeof parsed !== 'object') {
		throw new Error('Invalid secrets file: expected YAML object');
	}

	// Parse vault section
	const vault = parsed.vault ? {
		address: parsed.vault.address,
		namespace: parsed.vault.namespace,
		path: parsed.vault.path,
		triggerRedeploy: parsed.vault.triggerRedeploy ?? false,
		auth: parsed.vault.auth ? {
			method: parsed.vault.auth.method,
			role_id: parsed.vault.auth.role_id,
			secret_id: parsed.vault.auth.secret_id,
			token: parsed.vault.auth.token,
			kube_role: parsed.vault.auth.kube_role
		} : undefined
	} : undefined;

	// Parse secrets section
	if (!parsed.secrets || !Array.isArray(parsed.secrets)) {
		throw new Error('Invalid secrets file: "secrets" must be an array');
	}

	const secrets: SecretDefinition[] = parsed.secrets.map((item: any) => {
		// Simple form: just a string (name = key)
		if (typeof item === 'string') {
			return {
				name: item.toUpperCase(),
				key: item.toLowerCase(),
				triggerRedeploy: undefined // Will use global default
			};
		}

		// Object form with explicit mapping
		if (typeof item === 'object' && item.name) {
			return {
				name: item.name,
				key: item.key || item.name.toLowerCase(),
				path: item.path,
				triggerRedeploy: item.triggerRedeploy // May be undefined
			};
		}

		throw new Error(`Invalid secret definition: ${JSON.stringify(item)}`);
	});

	return { vault, secrets };
}

/**
 * Parse and normalize a secrets file into a ready-to-use configuration
 */
export function parseAndNormalizeSecretsFile(
	content: string,
	defaultPath: string = 'secret/data'
): ParsedSecretsConfig {
	const config = parseSecretsFile(content);

	// Determine base vault path
	const basePath = config.vault?.path || defaultPath;

	// Global default for triggerRedeploy (false if not specified)
	const triggerRedeployDefault = config.vault?.triggerRedeploy ?? false;

	// Group secrets by their path
	const secretsByPath = new Map<string, SecretMapping[]>();

	for (const secret of config.secrets) {
		// Determine the full path for this secret
		let path: string;
		if (secret.path) {
			// Full path specified
			path = secret.path;
		} else {
			// Use base path
			path = basePath;
		}

		// Ensure path uses KV v2 format
		if (!path.includes('/data/')) {
			const parts = path.split('/');
			if (parts.length >= 2) {
				path = `${parts[0]}/data/${parts.slice(1).join('/')}`;
			}
		}

		// Add to the path group
		if (!secretsByPath.has(path)) {
			secretsByPath.set(path, []);
		}

		// Resolve triggerRedeploy: secret-level overrides global default
		const secretTriggerRedeploy = secret.triggerRedeploy !== undefined 
			? secret.triggerRedeploy 
			: triggerRedeployDefault;

		secretsByPath.get(path)!.push({
			envVar: secret.name,
			vaultKey: secret.key || secret.name.toLowerCase(),
			triggerRedeploy: secretTriggerRedeploy
		});
	}

	// Build auth override if present
	let authOverride: ParsedSecretsConfig['authOverride'];
	if (config.vault?.auth?.method) {
		authOverride = {
			method: config.vault.auth.method,
			roleId: config.vault.auth.role_id,
			secretId: config.vault.auth.secret_id,
			token: config.vault.auth.token,
			kubeRole: config.vault.auth.kube_role
		};
	}

	return {
		vaultPath: basePath,
		vaultAddress: config.vault?.address,
		vaultNamespace: config.vault?.namespace,
		authOverride,
		secretsByPath,
		triggerRedeployDefault
	};
}

/**
 * Read and parse a secrets file from a stack directory
 */
export async function readSecretsFile(stackDir: string): Promise<ParsedSecretsConfig | null> {
	const filePath = findSecretsFile(stackDir);
	if (!filePath) {
		return null;
	}

	try {
		const content = await Bun.file(filePath).text();
		return parseAndNormalizeSecretsFile(content);
	} catch (error) {
		console.error(`[Secrets] Failed to parse ${filePath}:`, error);
		throw error;
	}
}
