/**
 * Normalize a stack name to be valid (lowercase alphanumeric with hyphens/underscores)
 */
export function normalizeStackName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}
