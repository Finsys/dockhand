import crypto from 'node:crypto';
import os from 'node:os';
import { getSetting, setSetting } from './db';
import { sendEventNotification } from './notifications';

// RSA Public Key for license verification
// This key can only VERIFY signatures, not create them
// The private key is kept secret and used only for license generation
const LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoGJOObrKQyOPrDC+xSVh
Cq5WeUQqwvAl2xEoI5iOhJtHIvnlxayc2UKt9D5WVWS0dgzi41L7VD2OjTayrbL8
RxPXYh0EfMtnKoJZyFwN1XdlYk8yUjs2TRXnrw8Y+riuMjFWgUHmWUQTA7yBnJG6
9efCMUDREHwGglPIKhTstQfSqi2fNO1GCgY1W7JCMnE8CCpwLGvLodbWFUe1CwT0
OgRZRNWPljc/cX5DLSaB1RXFUnBM4O9YalNCNOR3HvEV/8HULFtDpZT0ZwRbC3K3
R8GFY97lrqADuWVaEdRRYdr402eAcd4DnRT62OjpEllNbRI3U5Wyj6EmYm3Cmc9Q
GwIDAQAB
-----END PUBLIC KEY-----`;

export type LicenseType = 'enterprise' | 'smb';

export interface LicensePayload {
	name: string;
	host: string;
	issued: string;
	expires: string | null;
	type: LicenseType;
	v?: number; // Version: 2 = RSA signed
}

export interface LicenseStatus {
	valid: boolean;
	active: boolean;
	payload?: LicensePayload;
	error?: string;
}

export interface StoredLicense {
	name: string;
	key: string;
	activated_at: string;
}

/**
 * Validates a license key using RSA-SHA256 signature verification
 */
export function validateLicense(licenseKey: string, currentHost?: string): LicenseStatus {
	try {
		// Clean the license key - remove whitespace, newlines, etc.
		const cleanKey = licenseKey.replace(/\s+/g, '');

		const parts = cleanKey.split('.');
		if (parts.length !== 2) {
			return { valid: false, active: false, error: 'Invalid license format' };
		}

		const [payloadBase64, signature] = parts;

		// Verify RSA-SHA256 signature
		const verify = crypto.createVerify('RSA-SHA256');
		verify.update(payloadBase64);
		const isValid = verify.verify(LICENSE_PUBLIC_KEY, signature, 'base64url');

		if (!isValid) {
			return { valid: false, active: false, error: 'Invalid license signature' };
		}

		// Decode payload
		const payload: LicensePayload = JSON.parse(
			Buffer.from(payloadBase64, 'base64url').toString()
		);

		// Check expiration
		if (payload.expires && new Date(payload.expires) < new Date()) {
			return { valid: false, active: false, error: 'License has expired', payload };
		}

		// Check host (allow wildcard matching)
		const hostToCheck = currentHost || os.hostname();
		if (payload.host !== '*') {
			const hostMatches =
				payload.host === hostToCheck ||
				(payload.host.startsWith('*.') && hostToCheck.endsWith(payload.host.slice(1)));

			if (!hostMatches) {
				return {
					valid: false,
					active: false,
					error: `License is not valid for this host (${hostToCheck})`,
					payload
				};
			}
		}

		return { valid: true, active: true, payload };
	} catch (error) {
		return {
			valid: false,
			active: false,
			error: `License validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
		};
	}
}

/**
 * Gets the currently stored license
 */
export async function getStoredLicense(): Promise<StoredLicense | null> {
	return getSetting('enterprise_license');
}

/**
 * Stores and activates a license
 */
export async function activateLicense(
	name: string,
	key: string
): Promise<{ success: boolean; error?: string; license?: StoredLicense }> {
	// Clean the key - remove whitespace, newlines, etc.
	const cleanKey = key.replace(/\s+/g, '');

	// Validate the license first (use getHostname() for Docker-aware hostname detection)
	const validation = validateLicense(cleanKey, getHostname());

	if (!validation.valid) {
		return { success: false, error: validation.error };
	}

	// Check if the name matches
	if (validation.payload && validation.payload.name !== name.trim()) {
		return {
			success: false,
			error: `License name mismatch. Expected "${validation.payload.name}", got "${name.trim()}"`
		};
	}

	// Store the license (with cleaned key)
	const license: StoredLicense = {
		name: name.trim(),
		key: cleanKey,
		activated_at: new Date().toISOString()
	};

	await setSetting('enterprise_license', license);

	return { success: true, license };
}

/**
 * Removes the current license
 */
export async function deactivateLicense(): Promise<boolean> {
	await setSetting('enterprise_license', null);
	return true;
}

/**
 * Checks if the current installation has an active enterprise license
 */
export async function isEnterprise(): Promise<boolean> {
	const stored = await getStoredLicense();
	if (!stored || !stored.key) {
		return false;
	}

	const validation = validateLicense(stored.key, getHostname());
	// Only true for enterprise licenses (SMB does not unlock enterprise features)
	return validation.valid && validation.active && validation.payload?.type === 'enterprise';
}

/**
 * Gets the license type if a valid license is active
 */
export async function getLicenseType(): Promise<LicenseType | null> {
	const stored = await getStoredLicense();
	if (!stored || !stored.key) {
		return null;
	}

	const validation = validateLicense(stored.key, getHostname());
	if (validation.valid && validation.active && validation.payload) {
		return validation.payload.type;
	}
	return null;
}

/**
 * Gets the full license status including validation
 */
export async function getLicenseStatus(): Promise<LicenseStatus & { stored?: StoredLicense }> {
	const stored = await getStoredLicense();

	if (!stored || !stored.key) {
		return { valid: false, active: false };
	}

	const validation = validateLicense(stored.key, getHostname());
	return { ...validation, stored };
}

/**
 * Gets the current hostname for license validation.
 *
 * In Docker: DOCKHAND_HOSTNAME is set by the entrypoint script from Docker API.
 * Outside Docker: Falls back to os.hostname().
 */
export function getHostname(): string {
	return process.env.DOCKHAND_HOSTNAME || os.hostname();
}

// Track when we last sent a license expiring notification
let lastLicenseExpiryNotification: number | null = null;
const LICENSE_EXPIRY_NOTIFICATION_COOLDOWN = 86400000; // 24 hours between notifications
const LICENSE_EXPIRY_WARNING_DAYS = 30; // Warn when license expires within 30 days

/**
 * Check if the enterprise license is expiring soon and send notification
 * Call this periodically (e.g., on startup and daily)
 */
export async function checkLicenseExpiry(): Promise<void> {
	try {
		const status = await getLicenseStatus();

		// Only check if we have an active license with an expiry date
		if (!status.valid || !status.active || !status.payload?.expires) {
			return;
		}

		const expiryDate = new Date(status.payload.expires);
		const now = new Date();
		const daysUntilExpiry = Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

		// Check if expiring within warning threshold
		if (daysUntilExpiry > 0 && daysUntilExpiry <= LICENSE_EXPIRY_WARNING_DAYS) {
			// Check cooldown to avoid spamming
			if (lastLicenseExpiryNotification && Date.now() - lastLicenseExpiryNotification < LICENSE_EXPIRY_NOTIFICATION_COOLDOWN) {
				return;
			}

			const licenseTypeName = status.payload.type === 'enterprise' ? 'Enterprise' : 'SMB';
			console.log(`[License] ${licenseTypeName} license expiring in ${daysUntilExpiry} days`);

			await sendEventNotification('license_expiring', {
				title: 'License expiring soon',
				message: `Your ${licenseTypeName} license expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? '' : 's'} (${expiryDate.toLocaleDateString()}). Contact support to renew.`,
				type: 'warning'
			});

			lastLicenseExpiryNotification = Date.now();
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[License] Failed to check license expiry:', errorMsg);
	}
}
