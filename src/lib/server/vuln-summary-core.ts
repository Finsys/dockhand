/**
 * Counting findings in the database rather than in the process.
 *
 * A scan's findings document can run to a megabyte, and an environment holds
 * thousands, so the header's four severity counts are counted where the rows
 * already are and only the numbers travel. How many images were scanned comes
 * from the caller: an image with no findings is still a scanned one.
 *
 * No database import here, so the statement and the row coercion are testable
 * on their own.
 */

import { SUMMARY_SEVERITIES } from '$lib/utils/vulnerability';

export interface SummaryCounts {
	total: number;
	critical: number;
	high: number;
	medium: number;
	low: number;
	images: number;
}

export const EMPTY_COUNTS: SummaryCounts = {
	total: 0, critical: 0, high: 0, medium: 0, low: 0, images: 0
};

/**
 * How each dialect walks the findings column.
 *
 * The column holds a JSON *string* whose content is the array, so both need an
 * explicit unwrap before they will iterate it, and they spell field access
 * differently once they do.
 */
export function summaryDialect(isPostgres: boolean) {
	return isPostgres
		? {
			// The column holds a JSON string whose content is the array, so it is
			// unwrapped once here and walked below.
			parsed: `case when vulnerabilities is not null
			              then (vulnerabilities::jsonb #>> '{}')::jsonb end`,
			// A document that parses but is not an array contributes nothing rather
			// than erroring.
			expand: `lateral jsonb_array_elements(
				case when jsonb_typeof(v.parsed) = 'array' then v.parsed else '[]'::jsonb end
			) f`,
			field: (name: string) => `f->>'${name}'`,
			count: (s: string) => `count(*) filter (where sev = '${s}')`
		}
		: {
			// json_valid guards the extract itself, and CASE evaluates in order, so a
			// row that will not parse is skipped rather than raising.
			parsed: `case when json_valid(vulnerabilities)
			              then json_extract(vulnerabilities, '$') end`,
			expand: `json_each(
				case when v.parsed is not null and json_type(v.parsed, '$') = 'array'
				     then v.parsed else '[]' end
			) f`,
			field: (name: string) => `json_extract(f.value, '$.${name}')`,
			count: (s: string) => `sum(case when sev = '${s}' then 1 else 0 end)`
		};
}

/**
 * The counting statement, split around the two values the caller binds, so the
 * pieces can be reassembled with the values as real bound parameters - a
 * hand-built placeholder list silently binds nothing.
 *
 * Findings are keyed by image, CVE, package and version, and the first one seen
 * under a key wins - the same rule the listing applies - so a key that appears
 * twice with different severities is counted once and the header agrees with
 * the table beneath it.
 */
export function summaryFragments(
	isPostgres: boolean,
	perImage = false
): {
	head: string;
	mid: string;
	tail: string;
} {
	const ENV = '\u0000ENV\u0000';
	const IMAGES = '\u0000IMAGES\u0000';
	const [head, rest] = summarySelect(isPostgres, ENV, IMAGES, perImage).split(ENV);
	const [mid, tail] = rest.split(IMAGES);
	return { head, mid, tail };
}

/** The statement with caller-supplied placeholder text (used by the fragments). */
export function summarySelect(
	isPostgres: boolean,
	envParam: string,
	imageParams: string,
	perImage = false
): string {
	const d = summaryDialect(isPostgres);
	const counts = SUMMARY_SEVERITIES.map((s) => `${d.count(s)} as ${s}`).join(', ');
	// Grouping by image answers "which image is vulnerable", which the environment-wide
	// total cannot: the same findings, counted one level down.
	const select = perImage
		? `select image_id, count(*) as total, ${counts}`
		: `select count(*) as total, ${counts}, count(distinct image_id) as images`;
	const group = perImage ? '\ngroup by image_id' : '';

	return `${select}
from (
  select image_id, cve, pkg, ver, sev from (
    select v.image_id,
           ${d.field('id')} as cve,
           ${d.field('package')} as pkg,
           ${d.field('version')} as ver,
           lower(${d.field('severity')}) as sev,
           row_number() over (
             partition by v.image_id, ${d.field('id')}, ${d.field('package')}, ${d.field('version')}
             order by v.scan_order
           ) as seen
    from (
      select image_id, ${d.parsed} as parsed,
             row_number() over (partition by image_id, scanner
                                order by scanned_at desc, id desc) as rn,
             row_number() over (order by scanned_at desc, id desc) as scan_order
      from vulnerability_scans
      where environment_id = ${envParam} and vulnerabilities is not null
    ) v,
    ${d.expand}
    where v.rn = 1 and v.image_id in (${imageParams})
  ) ranked where seen = 1
) d${group}`;
}

/** Coerce a driver row into counts; drivers disagree on number versus string. */
export function readSummaryRow(row: Record<string, unknown> | undefined): SummaryCounts {
	const n = (v: unknown) => {
		const parsed = typeof v === 'number' ? v : parseInt(String(v ?? 0), 10);
		return Number.isFinite(parsed) ? parsed : 0;
	};
	return {
		total: n(row?.total),
		critical: n(row?.critical),
		high: n(row?.high),
		medium: n(row?.medium),
		low: n(row?.low),
		images: n(row?.images)
	};
}
