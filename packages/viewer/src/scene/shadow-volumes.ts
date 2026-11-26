import type { Vec3 } from '@endfield-noclip/package-format/values';

import { type Plane, sweepPlanes } from './camera.ts';

/** depth layers: the sharp cascades, then the far layer */
export const SHADOW_LAYERS = 4;

/**
 * minimum camera-view squared relative screen size a caster must exceed to draw into each shadow layer,
 * matching PC high (`CSMScreenSizeMin0..2` = 0.005, 0.01, 0.02; `ASMScreenSizeMin` = 0.01)
 */
export const SHADOW_LAYER_MIN_SQUARED: readonly number[] = [
	0.005 * 0.005,
	0.01 * 0.01,
	0.02 * 0.02,
	0.01 * 0.01,
];

/**
 * the layers' volumes in the light's frame, for culling casters per layer: unit axes x, y (across the light)
 * and z (along it), and per layer the camera-relative centre's coordinates along them and the radius. a
 * caster reaches a layer while it's within the radius across the light, and between the layer's far side and
 * the caster reach beyond its near side along it
 */
export interface ShadowLayerVolumes {
	/** x, y and z, three floats each */
	axes: Float64Array;
	/** per layer: the centre along x, y and z, and the radius */
	layers: Float64Array;
	/** how far towards the sun casters are kept beyond a layer's radius, m */
	reach: number;
}

/**
 * volumes instances outside the camera frustum can still cast shadows from: the view frustum swept towards
 * the sun, bounded by the fitted shadow layers, plus spheres around local lights whose shadow tiles are due
 */
export interface CasterVolume {
	/** camera-relative frustum planes swept towards the sun */
	planes: readonly Plane[];
	/** the fitted shadow layers' volumes in the light's frame */
	layers: ShadowLayerVolumes;
	/** world-space spheres (x, y, z, radius) around local lights whose shadow tiles wait for casters */
	lights: Float64Array;
}

/**
 * @param planes the view's camera-relative frustum planes
 * @param towardsSun unit vector towards the sun
 * @param layers the fitted shadow layers' volumes
 * @param lights world-space spheres (x, y, z, radius) around what casts into local lights' shadow maps
 * @returns the volumes instances outside the view can cast shadows from: into the view along the sun, or into
 *   a local light's map
 */
export const offscreenCasters = (
	planes: readonly Plane[],
	towardsSun: Vec3,
	layers: ShadowLayerVolumes,
	lights: Float64Array,
): CasterVolume => ({
	planes: sweepPlanes(planes, [-towardsSun[0], -towardsSun[1], -towardsSun[2]], layers.reach),
	layers,
	lights,
});
