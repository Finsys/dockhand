/**
 * Build subprocess scripts as standalone bundles for production.
 *
 * Subprocesses run via Bun.spawn and need all dependencies bundled
 * since they can't access the SvelteKit build output's chunked modules.
 */

const subprocesses = ['metrics-subprocess', 'event-subprocess'];

console.log('[build-subprocesses] Bundling subprocess scripts...');

for (const name of subprocesses) {
	const result = await Bun.build({
		entrypoints: [`./src/lib/server/subprocesses/${name}.ts`],
		outdir: './build/subprocesses',
		target: 'bun',
		minify: false
	});

	if (!result.success) {
		console.error(`[build-subprocesses] Failed to bundle ${name}:`);
		for (const log of result.logs) {
			console.error(log);
		}
		process.exit(1);
	}

	console.log(`[build-subprocesses] Bundled ${name}.js`);
}

console.log('[build-subprocesses] Done');
