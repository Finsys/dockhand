/**
 * The containers page renders ONE logs panel - the container named by
 * currentLogsContainerId - so the session it remembers must be that one. Keeping more
 * leaves a row advertising a session no panel can show.
 */

export interface LogsSession {
	containerId: string;
	containerName: string;
}

/** The session list after opening logs for a container. */
export function nextLogsSessions(
	_current: LogsSession[],
	container: { id: string; name: string }
): LogsSession[] {
	return [{ containerId: container.id, containerName: container.name }];
}

/** Whether a container's row shows the lit "logs are open" icon. */
export function showsLogsIndicator(currentId: string | null, containerId: string): boolean {
	return currentId === containerId;
}

export interface PanelSelection {
	logsId: string | null;
	terminalId: string | null;
}

/**
 * The whole panel state after a click on a container's ROW, for both panels at once -
 * the page applies this verbatim, so a decision cannot drift into the component.
 *
 * Logs render one panel, so clicking the container already showing hides it and
 * clicking any other leaves it alone: a row click never blanks a panel belonging to a
 * different container. Terminals keep every session mounted, so clicking a container
 * that has one switches to it, and clicking one without hides whatever is up.
 */
export function panelsAfterRowClick(
	current: PanelSelection,
	containerId: string,
	hasTerminal: (id: string) => boolean
): PanelSelection {
	return {
		logsId: current.logsId === containerId ? null : current.logsId,
		terminalId: hasTerminal(containerId) ? containerId : null
	};
}
