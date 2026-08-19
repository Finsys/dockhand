import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnvironments, updateEnvironment, getSetting, setSetting } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { parseLabels, serializeLabels, MAX_LABELS } from '$lib/utils/label-colors';

async function getLabelColors(): Promise<Record<string, string>> {
	const colors = await getSetting('label_colors');
	return (colors && typeof colors === 'object' && !Array.isArray(colors)) ? colors : {};
}

/**
 * GET /api/labels
 *
 * @openapi
 * summary: List all unique environment labels with their usage counts, the environments carrying each label, and any custom color
 * resp-200: {labels:array<{label:string!, environments:array<{envId:integer!, envName:string!}>!, count:integer!, color:string}>!, colors:{}}
 * resp-200-example: {"labels":[{"label":"prod","environments":[{"envId":1,"envName":"Production"}],"count":1,"color":"#ff0000"}],"colors":{"prod":"#ff0000"}}
 * resp-403: Permission denied (requires environments:view)
 * resp-500: Failed to get labels
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('environments', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const environments = await getEnvironments();
		const customColors = await getLabelColors();

		const labelMap = new Map<string, { envId: number; envName: string }[]>();

		for (const env of environments) {
			const labels = parseLabels(env.labels as string | null);
			for (const label of labels) {
				if (!labelMap.has(label)) {
					labelMap.set(label, []);
				}
				labelMap.get(label)!.push({ envId: env.id, envName: env.name });
			}
		}

		const result = Array.from(labelMap.entries())
			.map(([label, envs]) => ({
				label,
				environments: envs,
				count: envs.length,
				color: customColors[label] || null
			}))
			.sort((a, b) => a.label.localeCompare(b.label));

		return json({ labels: result, colors: customColors });
	} catch (error) {
		console.error('Failed to get labels:', error);
		return json({ error: 'Failed to get labels' }, { status: 500 });
	}
};

/**
 * POST /api/labels — bulk label operations.
 * The action field selects the operation: rename (oldLabel + newLabel),
 * delete (label), add (label + environmentIds), or set-color (label + color).
 *
 * @openapi
 * summary: Perform a bulk label operation on environments — rename, delete, add to environments, or set a custom color — selected via the action field
 * description: environmentIds from GET /api/environments.
 * body: {action:string!, oldLabel:string, newLabel:string, label:string, environmentIds:array<integer>, color:string}
 * body-example: {"action":"rename","oldLabel":"staging","newLabel":"stg"}
 * resp-200: {success:boolean!, affected:integer}
 * resp-200-example: {"success":true,"affected":2}
 * resp-400: Invalid action or missing/empty required fields for the chosen action
 * resp-403: Permission denied (requires environments:edit)
 * resp-500: Failed to manage labels
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('environments', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json();
		const { action } = body;

		if (action === 'rename') {
			const { oldLabel, newLabel } = body;
			if (!oldLabel || !newLabel || typeof oldLabel !== 'string' || typeof newLabel !== 'string') {
				return json({ error: 'oldLabel and newLabel are required' }, { status: 400 });
			}
			const trimmed = newLabel.trim();
			if (!trimmed) {
				return json({ error: 'New label cannot be empty' }, { status: 400 });
			}

			const environments = await getEnvironments();
			let affected = 0;

			for (const env of environments) {
				const labels = parseLabels(env.labels as string | null);
				const idx = labels.indexOf(oldLabel);
				if (idx === -1) continue;

				if (labels.includes(trimmed)) {
					labels.splice(idx, 1);
				} else {
					labels[idx] = trimmed;
				}

				await updateEnvironment(env.id, { labels: serializeLabels(labels) });
				affected++;
			}

			// Migrate custom color from old label to new
			const customColors = await getLabelColors();
			if (customColors[oldLabel]) {
				if (!customColors[trimmed]) {
					customColors[trimmed] = customColors[oldLabel];
				}
				delete customColors[oldLabel];
				await setSetting('label_colors', customColors);
			}

			return json({ success: true, affected });
		}

		if (action === 'delete') {
			const { label } = body;
			if (!label || typeof label !== 'string') {
				return json({ error: 'label is required' }, { status: 400 });
			}

			const environments = await getEnvironments();
			let affected = 0;

			for (const env of environments) {
				const labels = parseLabels(env.labels as string | null);
				const idx = labels.indexOf(label);
				if (idx === -1) continue;

				labels.splice(idx, 1);
				await updateEnvironment(env.id, { labels: serializeLabels(labels) });
				affected++;
			}

			// Remove custom color
			const customColors = await getLabelColors();
			if (customColors[label]) {
				delete customColors[label];
				await setSetting('label_colors', customColors);
			}

			return json({ success: true, affected });
		}

		if (action === 'add') {
			const { label, environmentIds } = body;
			if (!label || typeof label !== 'string' || !label.trim()) {
				return json({ error: 'label is required' }, { status: 400 });
			}
			if (!Array.isArray(environmentIds) || environmentIds.length === 0) {
				return json({ error: 'environmentIds array is required' }, { status: 400 });
			}

			const trimmed = label.trim();
			const environments = await getEnvironments();
			const targetIds = new Set(environmentIds.map(Number));
			let affected = 0;

			for (const env of environments) {
				if (!targetIds.has(env.id)) continue;
				const labels = parseLabels(env.labels as string | null);
				if (labels.includes(trimmed)) continue;
				if (labels.length >= MAX_LABELS) continue;

				labels.push(trimmed);
				await updateEnvironment(env.id, { labels: serializeLabels(labels) });
				affected++;
			}

			return json({ success: true, affected });
		}

		if (action === 'set-color') {
			const { label, color } = body;
			if (!label || typeof label !== 'string') {
				return json({ error: 'label is required' }, { status: 400 });
			}

			const customColors = await getLabelColors();
			if (color && typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
				customColors[label] = color;
			} else {
				delete customColors[label];
			}
			await setSetting('label_colors', customColors);

			return json({ success: true });
		}

		return json({ error: 'Invalid action. Use "rename", "delete", "add", or "set-color"' }, { status: 400 });
	} catch (error) {
		console.error('Failed to manage labels:', error);
		return json({ error: 'Failed to manage labels' }, { status: 500 });
	}
};
