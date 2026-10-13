// Whether the stack row's management actions (edit / logs / start / restart /
// stop) should render. They show for a stack in ANY state EXCEPT a git stack that
// has not been deployed yet - that one shows only its dedicated deploy button, so
// the management actions would be redundant. A non-git stack that is stopped or
// freshly created still needs its Start button, so deploy status must not hide the
// management actions. `status` is the raw stack status; a git stack that has never
// deployed is raw "created" (shown as "not deployed" elsewhere).

export function showsManagementActions(sourceType: string | undefined, status: string): boolean {
	return !(sourceType === 'git' && status === 'created');
}
