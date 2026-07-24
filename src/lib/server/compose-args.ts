export interface ComposeOperationArgOptions {
	forceRecreate?: boolean;
	removeVolumes?: boolean;
	build?: boolean;
	noBuildCache?: boolean;
	pullPolicy?: string;
	serviceName?: string;
}

// Operation-specific compose CLI args, split out of executeLocalCompose for unit testing.
export function buildComposeOperationArgs(
	operation: 'up' | 'down' | 'stop' | 'start' | 'restart' | 'pull' | 'build',
	options: ComposeOperationArgOptions = {}
): string[] {
	const { forceRecreate, removeVolumes, build, noBuildCache, pullPolicy, serviceName } = options;
	const args: string[] = [];

	switch (operation) {
		case 'up':
			args.push('up', '-d', '--remove-orphans');
			if (forceRecreate) args.push('--force-recreate');
			if (build && !noBuildCache) args.push('--build');
			if (pullPolicy) args.push('--pull', pullPolicy);
			// If targeting a specific service, only update that service
			if (serviceName) {
				args.push(serviceName);
			}
			break;
		case 'down':
			args.push('down', '--remove-orphans');
			if (removeVolumes) args.push('--volumes');
			break;
		case 'stop':
			args.push('stop');
			break;
		case 'start':
			args.push('start');
			break;
		case 'restart':
			args.push('restart');
			break;
		case 'pull':
			args.push('pull');
			// If targeting a specific service, pull only that service
			if (serviceName) {
				args.push(serviceName);
			}
			break;
		case 'build':
			args.push('build');
			if (noBuildCache) args.push('--no-cache');
			if (pullPolicy) args.push('--pull');
			if (serviceName) {
				args.push(serviceName);
			}
			break;
	}

	return args;
}

// Hawser's remote agent has no 'build' operation yet (see #880, #1020), so the separate
// no-cache build step only runs for local/direct deployments until it does.
export function shouldRunSeparateBuildStep(
	build: boolean | undefined,
	noBuildCache: boolean | undefined,
	connectionType: string | null | undefined
): boolean {
	const isHawser = connectionType === 'hawser-standard' || connectionType === 'hawser-edge';
	return !!build && !!noBuildCache && !isHawser;
}
