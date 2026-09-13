/**
 * The ONE formula for a stack's folder under a base dir on a host: `<base>/<stack>`.
 * Deploy staging (write) and backup (read) share it so they can't diverge (#1383 / #1240).
 * Pure + dependency-free, so both sides can import it.
 */

/** Trim + drop trailing slashes: `/data/stacks/` -> `/data/stacks`. */
export function normalizeBaseDir(base: string): string {
	return base.trim().replace(/\/+$/, '');
}

/** `<normalized base>/<stackName>`. Name is used verbatim - do NOT slugify (both sides use it raw). */
export function stackDirIn(base: string, stackName: string): string {
	return `${normalizeBaseDir(base)}/${stackName}`;
}
