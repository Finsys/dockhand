// Merge a git stack's repo .env vars with its DB override vars for display in the
// editor. The save path stores only overrides (vars that differ from the repo .env,
// plus secrets), so a reopened editor would otherwise show only the changed vars - the
// untouched repo vars vanish even though the deploy still applies them.
//
// Precedence mirrors deploy (stacks.ts: repo .env first, .env.dockhand + secrets on
// top): file value is the base, a DB non-secret var overrides its key, a DB secret
// (masked '***') always wins over any same-named file key.

import type { EnvVar } from '$lib/components/StackEnvVarsEditor.svelte';

export type { EnvVar };

// The load-bearing git-sync predicate: an editor var is stored to the DB only when it
// differs from the repo .env value, is new (no file entry), or is a secret. Everything
// file-equal and non-secret is dropped so the DB stays override-only. Shared by the
// modal's save filter, the re-populate preserve step, and the merge round-trip test so
// the invariant has one definition.
export function isGitStackOverride(v: EnvVar, fileVars: Record<string, string>): boolean {
	if (!v.key.trim()) return false;
	const fileValue = fileVars[v.key];
	return fileValue === undefined || v.value !== fileValue || v.isSecret;
}

export function mergeGitStackEnvVars(
	fileVars: Record<string, string>,
	dbVars: EnvVar[]
): EnvVar[] {
	const dbByKey = new Map<string, EnvVar>();
	for (const v of dbVars) {
		const key = v.key.trim();
		if (key) dbByKey.set(key, v);
	}

	const merged: EnvVar[] = [];
	const seen = new Set<string>();

	// File vars form the base, in file order. A DB var with the same key overrides it.
	for (const [key, value] of Object.entries(fileVars)) {
		const override = dbByKey.get(key);
		if (override) {
			merged.push({ key, value: override.value, isSecret: override.isSecret });
		} else {
			merged.push({ key, value, isSecret: false });
		}
		seen.add(key);
	}

	// DB-only vars (user overrides / secrets with no file counterpart) keep their order.
	for (const v of dbVars) {
		const key = v.key.trim();
		if (!key || seen.has(key)) continue;
		merged.push({ key, value: v.value, isSecret: v.isSecret });
		seen.add(key);
	}

	return merged;
}
