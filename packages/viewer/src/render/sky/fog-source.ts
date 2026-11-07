import fogWgsl from './fog.wgsl?raw';

const FROXELS_BINDING = '@group(1) @binding(5) var froxel_texture';

/**
 * @param froxels the bind group and binding of the volumetric fog's froxel texture
 * @returns fog.wgsl with its froxels there
 * @throws {Error} if fog.wgsl no longer declares its froxels where this expects
 */
export const fogSource = (froxels: { group: number; binding: number }): string => {
	if (!fogWgsl.includes(FROXELS_BINDING)) {
		throw new Error(`fog.wgsl no longer declares \`${FROXELS_BINDING}\``);
	}
	return fogWgsl.replace(
		FROXELS_BINDING,
		`@group(${froxels.group}) @binding(${froxels.binding}) var froxel_texture`,
	);
};
