// Restore-redeploy orchestration, extracted so the STEP ORDER is unit-testable without the
// real port's IO. Invariant: register(internal) runs BEFORE deploy and is NOT gated on the
// deploy succeeding - a failed `docker compose up` must still leave an editable managed stack.

export interface RedeployStackSteps {
	/** Restore snapshot secrets into the target env's DB (no-op when none / opted out). */
	restoreSecrets(): Promise<void>;
	/** Materialise compose/.env into the canonical stack dir. false -> hard error (nothing to deploy). */
	materialise(): Promise<boolean>;
	/** Register the stack as managed (internal) so the UI can edit/redeploy it. */
	register(): Promise<void>;
	/** `docker compose up` from the canonical dir. Throwing means the deploy failed. */
	deploy(): Promise<void>;
	log?(msg: string): void;
}

/** Order: restoreSecrets -> materialise -> register(internal) -> deploy. materialise false is a
 *  hard error; a deploy throw propagates but only AFTER register(), so it never costs the stack. */
export async function runRedeployStack(steps: RedeployStackSteps): Promise<void> {
	const log = steps.log ?? (() => {});

	await steps.restoreSecrets();

	const wrote = await steps.materialise();
	if (!wrote) throw new Error('could not materialise stack files; cannot redeploy');
	log('materialised OK');

	// Register BEFORE deploy - see the module header. This line order is the whole point.
	await steps.register();
	log('registered as managed (internal)');

	log('redeploying (docker compose up)');
	await steps.deploy();
	log('redeploy OK');
}
