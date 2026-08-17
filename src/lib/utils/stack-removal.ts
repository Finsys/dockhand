export interface StackRemovalOptions {
	deleteFiles: boolean;
	deleteVolumes: boolean;
}

export const DEFAULT_STACK_REMOVAL_OPTIONS: Readonly<StackRemovalOptions> = {
	deleteFiles: false,
	deleteVolumes: false
};

export function buildStackRemovalSearchParams(options: StackRemovalOptions): URLSearchParams {
	const params = new URLSearchParams({
		force: 'true',
		files: String(options.deleteFiles)
	});
	if (options.deleteVolumes) params.set('volumes', 'true');
	return params;
}

/** Parse the existing delete API flags while retaining its legacy file-deletion default. */
export function parseStackRemovalSearchParams(searchParams: URLSearchParams): {
	force: boolean;
	removeVolumes: boolean;
	deleteFiles: boolean;
} {
	return {
		force: searchParams.get('force') === 'true',
		removeVolumes: searchParams.get('volumes') === 'true',
		// Existing clients that omit `files` keep the historical delete-files behavior.
		deleteFiles: searchParams.get('files') !== 'false'
	};
}
