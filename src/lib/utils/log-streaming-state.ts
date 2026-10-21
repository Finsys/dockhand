/**
 * Helper to determine consistent styling and iconography for log streaming controls.
 *
 * Prevents UX confusion (issue #1654) where a button showing "Pause" with an active
 * amber highlight makes the user believe logs are currently paused when streaming is
 * actually active.
 *
 * Design principle:
 * - Active streaming state: Amber highlighted button indicating live streaming is running.
 *   The tooltip and aria/action convey that clicking will pause.
 *   The displayed status/label or action clearly distinguishes active streaming vs paused state.
 */

export interface LogStreamingControlState {
	/** Whether streaming is active and the button should show active styling */
	isStreaming: boolean;
	/** Action to perform on click */
	action: 'pause' | 'resume';
	/** Classes for button styling based on streaming state and dark mode */
	buttonClass: string;
}

export function getStreamingControlState(
	streamingEnabled: boolean,
	darkMode: boolean
): LogStreamingControlState {
	const isStreaming = streamingEnabled;
	const action = isStreaming ? 'pause' : 'resume';

	const activeClass = darkMode
		? 'bg-amber-500/20 ring-1 ring-amber-500/50 text-amber-400'
		: 'bg-amber-500/30 ring-1 ring-amber-600/50 text-amber-700';

	const inactiveClass = darkMode
		? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
		: 'text-gray-500 hover:text-gray-700 hover:bg-gray-200';

	return {
		isStreaming,
		action,
		buttonClass: isStreaming ? activeClass : inactiveClass
	};
}
