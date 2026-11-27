// Pure env-var merge for converting an internal stack to a git stack (the "attach"
// flow). Kept dependency-free so the bun unit runner can load it (the handler drags in
// ./db + fs). The handler reads the three inputs (the on-disk .env, the editor's vars,
// the stored vars) and writes the result back.

export interface StackEnvVar {
	key: string;
	value: string;
	isSecret: boolean;
}

/**
 * Builds the env vars to store when attaching an internal stack to git.
 *
 * - `fileVars` (the stack's .env on disk) form the non-secret base. Reloaded right
 *   before conversion so a file edited outside Dockhand is not lost.
 * - `dbVars` (the editor's vars, from the request) are the authoritative values for the
 *   keys the user sees: a non-secret overrides the file value, and a secret sent masked
 *   (`***`) keeps the stored ciphertext of the same key instead of saving the mask.
 * - `existingVars` (the stored vars) supply those ciphertexts, and - when the request
 *   carries no editor vars at all - carry the stored secrets forward so they survive.
 *
 * A masked secret whose key has no stored secret counterpart is dropped (there is no
 * real value to keep). Later entries override earlier ones by key.
 */
export function buildAttachEnvVars(
	fileVars: Record<string, string> | null,
	dbVars: StackEnvVar[] | null,
	existingVars: StackEnvVar[]
): StackEnvVar[] {
	const existingByKey = new Map(existingVars.map((v) => [v.key, v]));
	const varsToSave = new Map<string, StackEnvVar>();

	for (const [key, value] of Object.entries(fileVars ?? {})) {
		varsToSave.set(key, { key, value, isSecret: false });
	}

	if (dbVars) {
		for (const variable of dbVars) {
			const key = variable.key?.trim();
			if (!key) continue;

			if (variable.isSecret && variable.value === '***') {
				const existingVar = existingByKey.get(key);
				if (existingVar?.isSecret) {
					varsToSave.set(key, { key, value: existingVar.value, isSecret: true });
				}
				continue;
			}

			varsToSave.set(key, {
				key,
				value: variable.value ?? '',
				isSecret: variable.isSecret ?? false
			});
		}
	} else {
		for (const variable of existingVars) {
			if (variable.isSecret) {
				varsToSave.set(variable.key, { key: variable.key, value: variable.value, isSecret: true });
			}
		}
	}

	return Array.from(varsToSave.values());
}
