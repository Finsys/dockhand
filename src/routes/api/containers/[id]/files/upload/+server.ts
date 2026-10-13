import { json } from '@sveltejs/kit';
import { putContainerArchive, inspectContainer, chownContainerPath } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import { parseChownSpec } from '$lib/server/chown-spec-core';
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

/**
 * POST /api/containers/{id}/files/upload - Upload files into a container
 *
 * @openapi
 * summary: Upload one or more files into a container directory (requires the 'exec' permission)
 * description: Send `multipart/form-data` with one or more `files` parts; each file is tar-wrapped and written into the target directory. Partial success is reported per file in `uploaded`/`errors`.
 * body-multipart: files:binary[]! One or more files to write into the target directory
 * body-multipart: owner:string Optional owner ("user", "user:group", "uid" or "uid:gid") to chown the uploaded files to; defaults to the container's configured user
 * path: id:string! Container ID or name (from GET /api/containers)
 * query: env:integer! The target environment ID the container lives in (from GET /api/environments)
 * query: path:string! Absolute target directory inside the container
 * resp-200: {success:boolean!, uploaded:array<string>!, errors:array<string>}
 * resp-200-example: {"success":true,"uploaded":["app.conf"]}
 * resp-400: Target path missing, or no files provided
 * resp-403: Permission denied to write to the path
 * resp-404: Target directory not found
 * resp-500: Failed to upload the files
 */
export const POST: RequestHandler = async ({ params, url, request, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const path = url.searchParams.get('path');
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? Number.parseInt(envId) : undefined;

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

		// Explicit owner from the form wins; otherwise fall back to the container's
		// default user (Config.User), matching the pre-existing behaviour.
		let owner: string | undefined;
		const ownerField = formData.get('owner');
		if (typeof ownerField === 'string' && ownerField.trim() !== '') {
			const parsed = parseChownSpec(ownerField);
			if ('error' in parsed) {
				return json({ error: parsed.error }, { status: 400 });
			}
			owner = parsed.value;
		} else {
			try {
				const inspectData = await inspectContainer(params.id, envIdNum);
				const defaultUser = inspectData.Config.User || undefined;
				if (defaultUser) {
					owner = defaultUser.includes(':') ? defaultUser : `${defaultUser}:${defaultUser}`;
				}
			} catch (e) {
				console.warn('Failed to inspect container for user info', e);
			}
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
					envId ? Number.parseInt(envId) : undefined
				);

				// chown the uploaded file to the requested (or container-default) owner.
				if (owner) {
					const targetPath = path.endsWith('/') ? `${path}${file.name}` : `${path}/${file.name}`;
					try {
						await chownContainerPath(params.id, targetPath, owner, true, envId ? Number.parseInt(envId) : undefined);
					} catch (e) {
						console.warn('Failed to set ownership on', targetPath, e);
					}
				}

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
