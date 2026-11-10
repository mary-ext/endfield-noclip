import { BlobKind } from '@endfield-noclip/package-format/blobs';
import { CORE_ARCHIVE_INDEX } from '@endfield-noclip/package-format/manifest';

import type { ViewerPackage } from '../package/viewer-package.ts';

/**
 * the coarse layer, pinned at load: the core archive's height pages and instance blocks (coarse terrain,
 * every HLOD block, global scenery), and where the terrain draws surfaces, its surface pages.
 *
 * @param pkg the package
 * @param options `surfaces` when the terrain draws surface pages and close-up layers (BC textures)
 * @returns the blobs to pin, each once
 */
export const coreBlobs = (
	pkg: Pick<ViewerPackage, 'blobs' | 'manifest'>,
	options: { surfaces: boolean },
): number[] => {
	const blobs: number[] = [];
	for (let i = 0; i < pkg.blobs.length; i++) {
		const blob = pkg.blobs[i];
		if (blob.archive !== CORE_ARCHIVE_INDEX) {
			continue;
		}
		switch (blob.kind) {
			case BlobKind.TerrainHeights:
			case BlobKind.Instances: {
				blobs.push(i);
				break;
			}
			case BlobKind.TerrainSurface: {
				if (options.surfaces) {
					blobs.push(i);
				}
				break;
			}
		}
	}
	return blobs;
};

/**
 * every terrain layer texture, which every splat page draws from all of; pinned when the first splat page
 * arrives rather than at load, since only ground within the splat pages' reach uses them (tens of MB)
 *
 * @param pkg the package
 * @returns the blobs to pin, each once
 */
export const terrainLayerBlobs = (pkg: Pick<ViewerPackage, 'manifest'>): number[] => {
	const splat = pkg.manifest.terrain?.splat ?? null;
	return splat === null ? [] : [...new Set([...splat.diffuse, ...splat.normal])];
};
