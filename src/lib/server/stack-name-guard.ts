const STACK_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * The one shape a stack name may take before it is joined into a filesystem path.
 *
 * Docker Compose already restricts a project name to this set (lowercase alphanumeric,
 * dash and underscore, starting with a letter or digit). Every path the stack routes
 * build is `<root>/<name>` or `<root>/<env>/<name>`, so the name is validated to this
 * shape before it reaches a path rather than the path being checked afterwards.
 *
 * Pure, so the rule is covered by a unit test.
 */
export function isValidStackName(name: string): boolean {
	return STACK_NAME.test(name);
}
