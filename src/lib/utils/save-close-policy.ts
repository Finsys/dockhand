/**
 * Whether the stack modal should close itself after a successful save.
 *
 * A plain save has nothing more to show, so it closes. A save that also deploys
 * now renders the compose output inside the modal, below the editor -- closing
 * would throw away the very thing the user asked for. The deploy keeps running
 * on the server either way (it is a job; see ComposeOutputModal's close handler),
 * so staying open costs nothing.
 */
export function shouldCloseAfterSave(deployed: boolean): boolean {
	return !deployed;
}
