import { json } from '@sveltejs/kit';
import { putContainerArchive } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';

/**
 * Create a simple tar archive from a single file
 * TAR format: 512-byte header followed by file content padded to 512 bytes
 */
function createTarArchive(filename: string, content: Uint8Array): Uint8Array {
	// TAR header is 512 bytes
	const header = new Uint8Array(512);
	const encoder = new TextEncoder();

	// File name (100 bytes)
	const nameBytes = encoder.encode(filename.slice(0, 99));
	header.set(nameBytes, 0);

	// File mode (8 bytes) - 0644
	header.set(encoder.encode('0000644\0'), 100);

	// Owner UID (8 bytes)
	header.set(encoder.encode('0000000\0'), 108);

	// Owner GID (8 bytes)
	header.set(encoder.encode('0000000\0'), 116);

	// File size in octal (12 bytes)
	const sizeOctal = content.length.toString(8).padStart(11, '0');
	header.set(encoder.encode(sizeOctal + '\0'), 124);

	// Modification time (12 bytes) - current time in octal
	const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0');
	header.set(encoder.encode(mtime + '\0'), 136);

	// Checksum placeholder (8 spaces initially)
	header.set(encoder.encode('        '), 148);

	// Type flag - '0' for regular file
	header[156] = 48; // '0'

	// Link name (100 bytes) - empty
	// Magic (6 bytes) - 'ustar\0'
	header.set(encoder.encode('ustar\0'), 257);

	// Version (2 bytes) - '00'
	header.set(encoder.encode('00'), 263);

	// Owner name (32 bytes)
	header.set(encoder.encode('root'), 265);

	// Group name (32 bytes)
	header.set(encoder.encode('root'), 297);

	// Calculate checksum
	let checksum = 0;
	for (let i = 0; i < 512; i++) {
		checksum += header[i];
	}
	const checksumOctal = checksum.toString(8).padStart(6, '0') + '\0 ';
	header.set(encoder.encode(checksumOctal), 148);

	// Calculate padding to 512-byte boundary
	const paddingSize = (512 - (content.length % 512)) % 512;
	const padding = new Uint8Array(paddingSize);

	// End of archive marker (two 512-byte zero blocks)
	const endMarker = new Uint8Array(1024);

	// Combine all parts
	const totalSize = header.length + content.length + paddingSize + endMarker.length;
	const tar = new Uint8Array(totalSize);

	let offset = 0;
	tar.set(header, offset);
	offset += header.length;
	tar.set(content, offset);
	offset += content.length;
	tar.set(padding, offset);
	offset += paddingSize;
	tar.set(endMarker, offset);

	return tar;
}

export const POST: RequestHandler = async ({ params, url, request, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const path = url.searchParams.get('path');
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'exec', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	if (!path) {
		return json({ error: 'Target path is required' }, { status: 400 });
	}

	try {
		const formData = await request.formData();
		const files = formData.getAll('files') as File[];

		if (files.length === 0) {
			return json({ error: 'No files provided' }, { status: 400 });
		}

		// For simplicity, we'll upload files one at a time
		// A more sophisticated implementation could pack multiple files into one tar
		const uploaded: string[] = [];
		const errors: string[] = [];

		for (const file of files) {
			try {
				const content = new Uint8Array(await file.arrayBuffer());
				const tar = createTarArchive(file.name, content);

				await putContainerArchive(
					params.id,
					path,
					tar,
					envId ? parseInt(envId) : undefined
				);

				uploaded.push(file.name);
			} catch (err: any) {
				errors.push(`${file.name}: ${err.message}`);
			}
		}

		if (errors.length > 0 && uploaded.length === 0) {
			return json({ error: 'Failed to upload files', details: errors }, { status: 500 });
		}

		return json({
			success: true,
			uploaded,
			errors: errors.length > 0 ? errors : undefined
		});
	} catch (error: any) {
		console.error('Error uploading to container:', error?.message || error);

		if (error.message?.includes('Permission denied')) {
			return json({ error: 'Permission denied to write to this path' }, { status: 403 });
		}
		if (error.message?.includes('No such file or directory')) {
			return json({ error: 'Target directory not found' }, { status: 404 });
		}

		return json({ error: 'Failed to upload files' }, { status: 500 });
	}
};
