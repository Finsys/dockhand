/**
 * Cancel a stream reader when the signal aborts.
 *
 * The listener must not RETURN the cancel() promise. A stream the far end dropped is
 * already errored, so cancel() rejects, and Node's EventTarget rethrows a rejected
 * listener result as an uncaught exception - which takes the whole process down.
 */
export function cancelReaderOnAbort(
	reader: { cancel(): Promise<void> },
	signal: AbortSignal | undefined
): void {
	signal?.addEventListener('abort', () => { reader.cancel().catch(() => {}); }, { once: true });
}
