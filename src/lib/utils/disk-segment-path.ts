// Dashboard disk-usage segment -> page it links to. Build cache links to the
// images page, where the prune-build-cache action lives.
export type DiskSegmentKey = 'images' | 'containers' | 'volumes' | 'buildCache';

export function diskSegmentPath(key: DiskSegmentKey): string | null {
	switch (key) {
		case 'images':
			return '/images';
		case 'containers':
			return '/containers';
		case 'volumes':
			return '/volumes';
		case 'buildCache':
			return '/images';
		default:
			return null;
	}
}
