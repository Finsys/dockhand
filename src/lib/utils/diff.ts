/**
 * Utility functions for computing diffs between objects for audit logging
 */

export interface FieldChange {
	field: string;
	oldValue: any;
	newValue: any;
}

export interface AuditDiff {
	changes: FieldChange[];
}

/**
 * Fields that should never be included in audit diffs (sensitive data)
 */
const SENSITIVE_FIELDS = new Set([
	'password',
	'sshPrivateKey',
	'sshPassphrase',
	'tlsKey',
	'tlsCert',
	'tlsCa',
	'hawserToken',
	'token',
	'secret',
	'apiKey'
]);

/**
 * Fields that should be shown as masked if changed
 */
const MASKED_FIELDS = new Set([
	'password',
	'sshPrivateKey',
	'sshPassphrase',
	'tlsKey',
	'hawserToken',
	'token',
	'secret',
	'apiKey'
]);

/**
 * Fields that should be skipped entirely (internal timestamps, etc.)
 */
const SKIP_FIELDS = new Set([
	'updatedAt',
	'createdAt',
	'id'
]);

/**
 * Compute the diff between two objects for audit logging
 * Returns only the fields that have changed
 */
export function computeAuditDiff(
	oldObj: Record<string, any> | null | undefined,
	newObj: Record<string, any> | null | undefined,
	options: {
		includeFields?: string[];
		excludeFields?: string[];
	} = {}
): AuditDiff | null {
	if (!oldObj || !newObj) {
		return null;
	}

	const changes: FieldChange[] = [];
	const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

	for (const key of allKeys) {
		// Skip internal fields
		if (SKIP_FIELDS.has(key)) continue;

		// Skip if excluded
		if (options.excludeFields?.includes(key)) continue;

		// Skip if includeFields specified and key not in it
		if (options.includeFields && !options.includeFields.includes(key)) continue;

		const oldVal = oldObj[key];
		const newVal = newObj[key];

		// Skip undefined new values (not provided in update)
		if (newVal === undefined) continue;

		// Check if values are different
		if (!isEqual(oldVal, newVal)) {
			// Handle sensitive fields - show as masked
			if (MASKED_FIELDS.has(key)) {
				// Only show change if the masked field actually changed
				const oldHasValue = oldVal !== null && oldVal !== undefined && oldVal !== '';
				const newHasValue = newVal !== null && newVal !== undefined && newVal !== '';

				if (oldHasValue !== newHasValue || (oldHasValue && newHasValue)) {
					changes.push({
						field: key,
						oldValue: oldHasValue ? '••••••••' : null,
						newValue: newHasValue ? '••••••••' : null
					});
				}
			} else if (SENSITIVE_FIELDS.has(key)) {
				// Skip entirely for other sensitive fields
				continue;
			} else {
				changes.push({
					field: key,
					oldValue: formatValue(oldVal),
					newValue: formatValue(newVal)
				});
			}
		}
	}

	if (changes.length === 0) {
		return null;
	}

	return { changes };
}

/**
 * Deep equality check for values
 */
function isEqual(a: any, b: any): boolean {
	// Handle null/undefined
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (a === undefined || b === undefined) return false;

	// Handle arrays
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((val, idx) => isEqual(val, b[idx]));
	}

	// Handle objects
	if (typeof a === 'object' && typeof b === 'object') {
		const keysA = Object.keys(a);
		const keysB = Object.keys(b);
		if (keysA.length !== keysB.length) return false;
		return keysA.every(key => isEqual(a[key], b[key]));
	}

	// Primitive comparison
	return a === b;
}

/**
 * Format a value for display in the diff
 */
function formatValue(val: any): any {
	if (val === null || val === undefined) {
		return null;
	}

	// Truncate long strings
	if (typeof val === 'string' && val.length > 200) {
		return val.substring(0, 200) + '...';
	}

	// Handle arrays - show count if too many items
	if (Array.isArray(val)) {
		if (val.length > 10) {
			return `[${val.length} items]`;
		}
		return val.map(formatValue);
	}

	// Handle objects - show keys if too complex
	if (typeof val === 'object') {
		const keys = Object.keys(val);
		if (keys.length > 10) {
			return `{${keys.length} properties}`;
		}
		const formatted: Record<string, any> = {};
		for (const key of keys) {
			formatted[key] = formatValue(val[key]);
		}
		return formatted;
	}

	return val;
}

/**
 * Format field name for display (camelCase to Title Case)
 */
export function formatFieldName(field: string): string {
	// Handle special cases
	const specialCases: Record<string, string> = {
		'tlsCa': 'TLS CA',
		'tlsCert': 'TLS certificate',
		'tlsKey': 'TLS key',
		'tlsSkipVerify': 'Skip TLS verification',
		'sshPrivateKey': 'SSH private key',
		'sshPassphrase': 'SSH passphrase',
		'envVars': 'Environment variables',
		'isDefault': 'Default',
		'ipAddress': 'IP address',
		'authType': 'Auth type',
		'eventTypes': 'Event types',
		'hawserToken': 'Hawser token',
		'connectionType': 'Connection type',
		'socketPath': 'Socket path',
		'collectActivity': 'Collect activity',
		'collectMetrics': 'Collect metrics',
		'highlightChanges': 'Highlight changes'
	};

	if (specialCases[field]) {
		return specialCases[field];
	}

	// Convert camelCase to Title Case with spaces
	return field
		.replace(/([A-Z])/g, ' $1')
		.replace(/^./, str => str.toUpperCase())
		.trim();
}
