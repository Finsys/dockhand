/**
 * Pure helpers for merging a generated single-service compose into an existing stack's
 * compose (the "Append to existing" flow, #489). Kept dependency-light (js-yaml only) so
 * the merge + highlight logic is unit-testable without a browser.
 */
import yaml from 'js-yaml';

export interface MergeResult {
	/** The merged compose YAML. */
	merged: string;
	/** The service key actually used (may be suffixed on a name clash). */
	key: string;
	/** True when the generated key clashed and a numbered suffix was applied. */
	renamed: boolean;
}

/**
 * Insert `serviceCompose`'s single service into `baseCompose`. On a name clash the added
 * service gets the lowest free `-N` suffix (never overwrites an existing service). Any
 * top-level `networks`/`volumes` the service references are carried over.
 */
export function mergeServiceIntoCompose(baseCompose: string, serviceCompose: string): MergeResult {
	const doc = (yaml.load(baseCompose) as any) ?? {};
	if (!doc.services || typeof doc.services !== 'object') doc.services = {};

	const generated = yaml.load(serviceCompose) as any;
	const genServices = generated?.services ?? {};
	const genKey = Object.keys(genServices)[0];
	if (!genKey) throw new Error('Nothing to add');

	let key = genKey;
	let renamed = false;
	if (doc.services[key]) {
		let n = 2;
		while (doc.services[`${genKey}-${n}`]) n++;
		key = `${genKey}-${n}`;
		renamed = true;
	}
	doc.services[key] = genServices[genKey];
	if (generated?.networks) doc.networks = { ...(doc.networks ?? {}), ...generated.networks };
	if (generated?.volumes) doc.volumes = { ...(doc.volumes ?? {}), ...generated.volumes };

	const merged = yaml.dump(doc, { lineWidth: -1, noRefs: true, sortKeys: false });
	return { merged, key, renamed };
}

/**
 * The 1-based inclusive line range of the `services.<key>:` block in the merged YAML, for
 * highlighting the added service. Returns [] if the key isn't found. Trailing blank lines
 * are ignored so a service that is the last block doesn't highlight the blank EOF line.
 */
export function computeAddedRange(mergedYaml: string, key: string): { line: number; endLine: number }[] {
	const lines = mergedYaml.split('\n');
	while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();

	let start = -1;
	let indent = 0;
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^(\s*)([\w.-]+):/);
		if (start === -1) {
			if (m && m[2] === key) {
				start = i;
				indent = m[1].length;
			}
		} else {
			// End the block at the next sibling key at the same-or-lower indent.
			const m2 = lines[i].match(/^(\s*)\S/);
			if (m2 && m2[1].length <= indent) {
				return [{ line: start + 1, endLine: i }];
			}
		}
	}
	if (start === -1) return [];
	return [{ line: start + 1, endLine: lines.length }];
}
