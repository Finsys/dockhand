/**
 * Vault Secrets Sync Module
 *
 * Synchronizes secrets from HashiCorp Vault to stack environment variables.
 */

import { readSecretsFile, type ParsedSecretsConfig } from './secrets-file.js';
import { createVaultClient, type VaultConfig, type VaultSecret } from './vault.js';
import { getVaultConfig, upsertStackEnvVars, getStackSource, getSecretEnvVarsAsRecord } from './db.js';

// =============================================================================
// TYPES
// =============================================================================

export interface SyncResult {
	success: boolean;
	synced: number;
	errors: string[];
	skipped: boolean;
	/**
	 * Whether any secret values changed during sync
	 */
	secretsChanged: boolean;
	/**
	 * Names of secrets that changed AND have triggerRedeploy enabled
	 */
	triggerRedeploySecrets: string[];
}

export interface StackSyncResult extends SyncResult {
	stackName: string;
}

// =============================================================================
// SYNC FUNCTIONS
// =============================================================================

/**
 * Synchronize secrets from Vault for a single stack
 *
 * @param stackName - Name of the stack
 * @param stackDir - Directory containing the stack files
 * @param environmentId - Optional environment ID
 * @returns Sync result with details
 */
export async function syncStackSecrets(
	stackName: string,
	stackDir: string,
	environmentId?: number | null
): Promise<SyncResult> {
	const errors: string[] = [];

	// Resolve environment ID from stack_sources if not provided
	// This handles cases where git_stacks.environment_id is NULL but stack_sources has the correct value
	let resolvedEnvId = environmentId;
	if (resolvedEnvId === null || resolvedEnvId === undefined) {
		try {
			// Try to find the stack source with any environment ID
			const { db, stackSources, eq } = await import('./db/drizzle.js');
			const sources = await db.select().from(stackSources)
				.where(eq(stackSources.stackName, stackName));
			
			// Use the first source's environment ID if available
			if (sources.length > 0 && sources[0].environmentId !== null) {
				resolvedEnvId = sources[0].environmentId;
				console.log(`[Vault] Resolved environment ID ${resolvedEnvId} for stack "${stackName}" from stack_sources`);
			}
		} catch (error) {
			// Ignore errors - proceed with NULL environment ID
			console.warn(`[Vault] Could not resolve environment ID for stack "${stackName}":`, error);
		}
	}

	// 1. Check for secrets file
	let secretsConfig: ParsedSecretsConfig | null;
	try {
		secretsConfig = await readSecretsFile(stackDir);
	} catch (error) {
		return {
			success: false,
			synced: 0,
			errors: [`Failed to parse secrets file: ${error instanceof Error ? error.message : String(error)}`],
			skipped: false,
			secretsChanged: false,
			triggerRedeploySecrets: []
		};
	}

	if (!secretsConfig) {
		// No secrets file - nothing to sync
		return {
			success: true,
			synced: 0,
			errors: [],
			skipped: true,
			secretsChanged: false,
			triggerRedeploySecrets: []
		};
	}

	// 2. Get global Vault config
	const globalConfig = await getVaultConfig();
	if (!globalConfig || !globalConfig.enabled) {
		return {
			success: false,
			synced: 0,
			errors: ['Vault is not configured or disabled. Configure Vault in Settings first.'],
			skipped: false,
			secretsChanged: false,
			triggerRedeploySecrets: []
		};
	}

	// 3. Build effective Vault config (global + overrides from secrets file)
	const effectiveConfig: VaultConfig = {
		address: secretsConfig.vaultAddress || globalConfig.address,
		namespace: secretsConfig.vaultNamespace || globalConfig.namespace || undefined,
		defaultPath: globalConfig.defaultPath || undefined,
		authMethod: secretsConfig.authOverride?.method || globalConfig.authMethod as VaultConfig['authMethod'],
		token: secretsConfig.authOverride?.token || globalConfig.token || undefined,
		roleId: secretsConfig.authOverride?.roleId || globalConfig.roleId || undefined,
		secretId: secretsConfig.authOverride?.secretId || globalConfig.secretId || undefined,
		kubeRole: secretsConfig.authOverride?.kubeRole || globalConfig.kubeRole || undefined,
		skipTlsVerify: globalConfig.skipTlsVerify ?? false,
		enabled: true
	};

	// 4. Connect to Vault
	let vaultClient;
	try {
		vaultClient = await createVaultClient(effectiveConfig);
	} catch (error) {
		return {
			success: false,
			synced: 0,
			errors: [`Failed to connect to Vault: ${error instanceof Error ? error.message : String(error)}`],
			skipped: false,
			secretsChanged: false,
			triggerRedeploySecrets: []
		};
	}

	// 4a. Fetch existing secret values for comparison
	let existingSecrets: Record<string, string> = {};
	try {
		existingSecrets = await getSecretEnvVarsAsRecord(stackName, resolvedEnvId);
		// #region agent log
		fetch('http://127.0.0.1:7244/ingest/82eed265-24ab-4eea-a445-5a08da005e0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'vault-sync.ts:146',message:'existingSecrets fetched',data:{stackName,resolvedEnvId,existingSecretsKeys:Object.keys(existingSecrets),count:Object.keys(existingSecrets).length},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
		// #endregion
	} catch (error) {
		console.warn(`[Vault] Could not fetch existing secrets for comparison:`, error);
		// Continue - we'll treat all secrets as new/changed
	}

	// 5. Fetch secrets from each path
	const allSecrets: Array<{ key: string; value: string; isSecret: true }> = [];
	// Track which secrets have triggerRedeploy enabled (envVar -> triggerRedeploy)
	const triggerRedeployMap = new Map<string, boolean>();

	for (const [path, mappings] of secretsConfig.secretsByPath) {
		try {
			// Get all keys we need from this path
			const keys = mappings.map(m => m.vaultKey);
			const secrets = await vaultClient.getSecrets(path, keys);

			// Map Vault keys to environment variable names
			const secretsByKey = new Map(secrets.map(s => [s.key, s.value]));

			for (const mapping of mappings) {
				const value = secretsByKey.get(mapping.vaultKey);
				if (value !== undefined) {
					allSecrets.push({
						key: mapping.envVar,
						value,
						isSecret: true
					});
					// Track triggerRedeploy setting for this secret
					triggerRedeployMap.set(mapping.envVar, mapping.triggerRedeploy);
				} else {
					errors.push(`Secret "${mapping.vaultKey}" not found at path "${path}"`);
				}
			}
		} catch (error) {
			errors.push(`Failed to read secrets from "${path}": ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// 5a. Compare old vs new values to detect changes
	const changedSecrets: string[] = [];
	const triggerRedeploySecrets: string[] = [];

	// #region agent log
	fetch('http://127.0.0.1:7244/ingest/82eed265-24ab-4eea-a445-5a08da005e0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'vault-sync.ts:189',message:'triggerRedeployMap',data:{map:Object.fromEntries(triggerRedeployMap)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'C'})}).catch(()=>{});
	// #endregion

	for (const secret of allSecrets) {
		const oldValue = existingSecrets[secret.key];
		const isChanged = oldValue === undefined || oldValue !== secret.value;

		// #region agent log
		fetch('http://127.0.0.1:7244/ingest/82eed265-24ab-4eea-a445-5a08da005e0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'vault-sync.ts:195',message:'secret comparison',data:{key:secret.key,oldValueExists:oldValue!==undefined,newValuePreview:secret.value?.substring(0,10),isChanged,triggerRedeploy:triggerRedeployMap.get(secret.key)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
		// #endregion

		if (isChanged) {
			changedSecrets.push(secret.key);
			// Check if this secret should trigger redeploy
			if (triggerRedeployMap.get(secret.key)) {
				triggerRedeploySecrets.push(secret.key);
			}
		}
	}

	const secretsChanged = changedSecrets.length > 0;
	// #region agent log
	fetch('http://127.0.0.1:7244/ingest/82eed265-24ab-4eea-a445-5a08da005e0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'vault-sync.ts:210',message:'sync result',data:{secretsChanged,changedSecrets,triggerRedeploySecrets},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'D'})}).catch(()=>{});
	// #endregion
	if (secretsChanged) {
		console.log(`[Vault] Detected ${changedSecrets.length} changed secrets for stack "${stackName}": ${changedSecrets.join(', ')}`);
		if (triggerRedeploySecrets.length > 0) {
			console.log(`[Vault] Secrets that will trigger redeploy: ${triggerRedeploySecrets.join(', ')}`);
		}
	}

	// 6. Save secrets to database
	if (allSecrets.length > 0) {
		try {
			await upsertStackEnvVars(stackName, resolvedEnvId ?? null, allSecrets);
			console.log(`[Vault] Synced ${allSecrets.length} secrets for stack "${stackName}" (env: ${resolvedEnvId ?? 'none'})`);
		} catch (error) {
			return {
				success: false,
				synced: 0,
				errors: [`Failed to save secrets to database: ${error instanceof Error ? error.message : String(error)}`],
				skipped: false,
				secretsChanged,
				triggerRedeploySecrets
			};
		}
	}

	return {
		success: errors.length === 0,
		synced: allSecrets.length,
		errors,
		skipped: false,
		secretsChanged,
		triggerRedeploySecrets
	};
}

/**
 * Synchronize secrets for all Git stacks
 *
 * @returns Map of stack names to their sync results
 */
export async function syncAllStackSecrets(): Promise<Map<string, SyncResult>> {
	const results = new Map<string, SyncResult>();

	// Import dynamically to avoid circular dependency
	const { getGitStacks } = await import('./db.js');
	const { getStackDir } = await import('./stacks.js');

	const stacks = await getGitStacks();

	for (const stack of stacks) {
		try {
			const stackDir = await getStackDir(stack);
			if (!stackDir) {
				results.set(stack.stackName, {
					success: false,
					synced: 0,
					errors: ['Stack directory not found'],
					skipped: false,
					secretsChanged: false,
					triggerRedeploySecrets: []
				});
				continue;
			}

			const result = await syncStackSecrets(
				stack.stackName,
				stackDir,
				stack.environmentId
			);
			results.set(stack.stackName, result);
		} catch (error) {
			results.set(stack.stackName, {
				success: false,
				synced: 0,
				errors: [error instanceof Error ? error.message : String(error)],
				skipped: false,
				secretsChanged: false,
				triggerRedeploySecrets: []
			});
		}
	}

	return results;
}
