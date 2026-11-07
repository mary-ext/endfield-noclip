/**
 * where the camera starts over a package or a level.
 *
 * @module
 */

import type { LevelInfo, PackageManifest } from '@endfield-noclip/package-format/manifest';
import { tileAt, tileId } from '@endfield-noclip/package-format/tiles';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { type EnvironmentScene, eyeInLevelVolume } from '../environment/blend.ts';

import { type GroundSource, type TreeFrame, groundHeight, sceneryTop } from './ground.ts';
import type { CameraPose } from './noclip-controls.ts';

/** how far over the terrain a level's first view stays (m) */
const VIEW_CLEARANCE = 100;
/** headings a level's first view tries, from the south round */
const VIEW_HEADINGS = 8;

/**
 * @param manifest the package's manifest
 * @returns a pose looking over the whole region
 */
export const overviewPose = (manifest: GroundSource['manifest']): CameraPose => {
	const { origin, rootSize } = manifest.tree;
	const terrain = manifest.terrain;
	const baseY = terrain === null ? 0 : terrain.baseHeight + terrain.heightScale / 2;
	return {
		position: [origin[0] + rootSize / 2, baseY + rootSize * 0.45, origin[1] + rootSize / 2 - rootSize * 0.85],
		yaw: 0,
		pitch: -0.5,
	};
};

/**
 * @param manifest the package's manifest
 * @param level one of its levels
 * @returns {@link TileNode.cellId} s of the level's cells
 */
export const levelCellIds = (manifest: { tree: TreeFrame }, level: Pick<LevelInfo, 'cells'>): Set<string> => {
	const cellLevel = manifest.tree.cellLevel;
	return new Set(level.cells.map(([x, z]) => tileId({ level: cellLevel, x, z })));
};

/**
 * @param manifest the package's manifest
 * @returns the levels by the {@link TileNode.cellId} s of the cells they own
 */
export const levelsByCell = (manifest: Pick<PackageManifest, 'tree' | 'levels'>): Map<string, LevelInfo> => {
	const byCell = new Map<string, LevelInfo>();
	for (const level of manifest.levels) {
		for (const id of levelCellIds(manifest, level)) {
			if (!byCell.has(id)) {
				byCell.set(id, level);
			}
		}
	}
	return byCell;
};

/**
 * @param tree the package's tree frame
 * @param point a world position
 * @returns the {@link TileNode.cellId} of the cell under the point, as {@link levelsByCell} keys it
 */
export const cellIdAt = (tree: TreeFrame, point: Vec3): string =>
	tileId(tileAt(tree, tree.cellLevel, point[0], point[2]));

/**
 * @param ground the package's ground, with its environment table and manifest
 * @param level the level to look over
 * @param options whether the view keeps where the level's own environment applies, and the condition results
 *   that decide which volumes apply
 * @returns a pose looking over the level's playable rectangle (over the terrain, or the spawn height off it)
 *   from the heading that keeps the widest view where the level's own environment applies, and whether it's
 *   settled: unsettled poses fell back to the spawn height while the coarse pages load
 */
export const levelPose = (
	ground: GroundSource & EnvironmentScene,
	level: LevelInfo,
	options: { environmentVolumes: boolean; loaded: readonly boolean[] },
): { pose: CameraPose; settled: boolean } => {
	const { rect, playerInitPos } = level;
	const cx = (rect.minX + rect.maxX) / 2;
	const cz = (rect.minZ + rect.maxZ) / 2;
	const extent = Math.max(rect.maxX - rect.minX, rect.maxZ - rect.minZ);
	const terrain = groundHeight(ground, cx, cz);
	const floor = terrain ?? playerInitPos[1];
	const back = extent * 0.75;
	const up = extent * 0.55;
	const pitch = -Math.atan2(up, back);
	const settled = terrain !== undefined;
	// looking north from the south, unless the level's volume can't hold that view
	const fromHeading = (yaw: number): Vec3 => [
		cx - Math.sin(yaw) * back,
		floor + up,
		cz - Math.cos(yaw) * back,
	];
	const fallback = { pose: { position: fromHeading(0), yaw: 0, pitch }, settled };
	const base = level.environment ?? undefined;
	if (base === undefined || !options.environmentVolumes) {
		return fallback;
	}
	const target: Vec3 = [cx, floor, cz];
	const index = ground.manifest.levels.indexOf(level);
	let best: { position: Vec3; yaw: number; distance: number } | null = null;
	for (let i = 0; i < VIEW_HEADINGS; i++) {
		const yaw = (i / VIEW_HEADINGS) * 2 * Math.PI;
		const position = eyeInLevelVolume(ground, index, base, target, fromHeading(yaw), {
			loaded: options.loaded,
			// over the treetops and the cell's tallest scenery (Yinglung's chasm walls are meshes). holes in the
			// terrain aren't clear; terrain that isn't resident yet is
			clear: ([x, y, z]) => {
				const height = groundHeight(ground, x, z);
				return (
					height !== null && y >= (height ?? -Infinity) + VIEW_CLEARANCE && y >= sceneryTop(ground, x, z)
				);
			},
		});
		if (position === null) {
			continue;
		}
		const distance = Math.hypot(position[0] - cx, position[1] - floor, position[2] - cz);
		if (best === null || distance > best.distance + 1) {
			best = { position, yaw, distance };
		}
		// the usual heading wins while it keeps half its reach: other headings can land inside scenery the
		// terrain check doesn't see
		if (i === 0 && distance >= Math.hypot(back, up) / 2) {
			break;
		}
	}
	if (best === null) {
		return fallback;
	}
	return { pose: { position: best.position, yaw: best.yaw, pitch }, settled };
};
