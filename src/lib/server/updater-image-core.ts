/**
 * Which dockhand-updater sidecar image self-update should launch.
 *
 * The default updater is Wolfi-based (compiled for x86-64-v2). On old x86_64 CPUs
 * without v2 - the same hardware that runs the baseline Dockhand image
 * (DOCKHAND_VARIANT=baseline) - the Wolfi updater can't exec and Docker reports exit
 * 127 at "Launching updater", so self-update is broken. Those hosts must pull the
 * `-baseline` (Alpine/musl) updater instead, mirroring the backup helper's variant
 * split (see restic.ts HELPER_VARIANT_SUFFIX).
 */
export function updaterImageForVariant(variant: string | undefined): string {
	const suffix = variant === 'baseline' ? '-baseline' : '';
	return `fnsys/dockhand-updater:latest${suffix}`;
}
