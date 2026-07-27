import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { auditBackup } from '$lib/server/audit';
import { cancelBackup } from '$lib/server/backups';
import { requireBackups, loadConfigGateEnv } from '$lib/server/backups/route-guards';

export const POST: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'manage');
	if (denied) return denied;

	// (bug #12) Enforce per-env access, which this route previously OMITTED — a
	// user with global backups:manage but no role on the config's env could
	// cancel an in-flight backup there. loadConfigGateEnv can't be called without
	// the env gate, so the omission is now unrepresentable.
	const gated = await loadConfigGateEnv(params.id, auth);
	if ('response' in gated) return gated.response;
	const cfg = gated.config;

	try {
		const stopped = await cancelBackup(cfg.id);
		// 'stop' is the canonical audit action for "abort running operation"
		await auditBackup(event, 'stop', cfg.targetName, cfg.environmentId, { configId: cfg.id, killed: stopped });
		return json({ success: true, stopped });
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return json({ error: msg }, { status: 500 });
	}
};
