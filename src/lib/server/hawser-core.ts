/**
 * hawser-core.ts — the PURE parts of the Hawser Edge protocol message routing: no DB import,
 * so it is unit-testable directly (importing hawser.ts pulls in db/drizzle -> better-sqlite3,
 * which bun's test runner can't load). hawser.ts re-exports this so callers have one import site.
 */

/** The minimal shape dispatchStreamMessage needs off an EdgeConnection. */
export interface StreamDispatchTarget {
	pendingStreamRequests?: Map<string, { onData?: (data: string, stream?: 'stdout' | 'stderr') => void }>;
	// Line callbacks for non-streaming requests (e.g. compose) that still want to observe
	// 'stream' messages as they arrive. Separate from pendingStreamRequests, which belongs
	// to requests sent with streaming: true (see sendEdgeStreamRequest in hawser.ts).
	lineHandlers?: Map<string, (line: string) => void>;
}

/**
 * Route a 'stream' message from the agent to whichever consumer is waiting for it.
 *
 * Two independent registries can claim a requestId: pendingStreamRequests (requests sent
 * with streaming: true) and lineHandlers (non-streaming requests, e.g. compose, that still
 * want to observe line-by-line output as it arrives). A requestId is only ever registered in
 * one of the two — pendingStreamRequests is checked first, matching the previous behaviour of
 * the inline 'stream' case this was extracted from.
 *
 * Compose requests are sent with streaming: false and land in pendingRequests only. Before
 * this function existed, the message dispatcher's 'stream' case looked up pendingStreamRequests
 * exclusively, so any line message for a non-streaming request vanished silently — no error, no
 * warning.
 */
export function dispatchStreamMessage(
	connection: StreamDispatchTarget,
	msg: { requestId: string; data: unknown }
): void {
	const streamPending = connection.pendingStreamRequests?.get(msg.requestId);
	if (streamPending) {
		streamPending.onData?.(msg.data as string);
		return;
	}

	const lineHandler = connection.lineHandlers?.get(msg.requestId);
	if (!lineHandler) return; // no handler registered: drop silently, this is the normal case

	// Go marshals StreamMessage.Data ([]byte) as base64 -- sendEdgeStreamRequest's onData
	// callback does the same decode on the streaming path. Without this, the UI shows base64
	// gibberish instead of readable output.
	const text = typeof msg.data === 'string' ? Buffer.from(msg.data, 'base64').toString('utf8') : '';
	if (text) lineHandler(text);
}
