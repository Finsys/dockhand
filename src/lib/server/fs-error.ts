/**
 * Describe a filesystem failure by everything the diagnosis needs.
 *
 * `message` alone drops the fields that identify the fault: the code says what was
 * refused, the syscall says which operation asked, and the path says on what. Several
 * different faults read almost identically without them, so a report carrying only the
 * message cannot be told apart from a different cause.
 */
export function describeFsError(e: unknown): string {
	if (!(e instanceof Error)) return String(e);
	const err = e as Error & {
		code?: string; syscall?: string; path?: string; dest?: string; errno?: number;
	};
	const detail: string[] = [];
	if (err.code) detail.push(`code=${err.code}`);
	if (err.syscall) detail.push(`syscall=${err.syscall}`);
	if (typeof err.errno === 'number') detail.push(`errno=${err.errno}`);
	if (err.path) detail.push(`path=${err.path}`);
	if (err.dest) detail.push(`dest=${err.dest}`);
	return detail.length > 0 ? `${err.message} [${detail.join(' ')}]` : err.message;
}
