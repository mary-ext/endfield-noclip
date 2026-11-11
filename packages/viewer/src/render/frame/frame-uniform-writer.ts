/**
 * the TS side of `frame.wgsl`'s `Frame` struct: its layout, and the writer that packs a frame into it.
 *
 * @module
 */

import { TERRAIN_HOLE_BIT, type TerrainInfo } from '@endfield-noclip/package-format/terrain';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import type { Environment } from '../../environment/environment.ts';
import type { Camera } from '../../scene/camera.ts';
import type { LocalLightFrame } from '../lighting/local-lights.ts';
import type { ShadowMap } from '../shadows/shadow-map.ts';

import { DEBUG_VIEWS, type DebugView } from './debug-views.ts';
import type { FrameBindings } from './frame-bindings.ts';

/** byte size of `Frame` */
export const FRAME_UNIFORM_BYTES = 928;

/** float offsets of `Frame` fields */
export const FrameOffsets = {
	// camera
	viewProj: 0,
	eye: 16,
	viewForward: 20,
	viewRight: 24,
	viewUp: 28,
	viewport: 32,
	renderSize: 36,
	// lighting
	sun: 40,
	sunColor: 44,
	/** 7 vec4s */
	sh: 48,
	ambient: 76,
	/** three vec4s: irradiance clipmap centres, w = filled */
	irradiance: 80,
	/** light count, tiles across and down, near plane */
	localLights: 92,
	// terrain and debug
	terrain: 96,
	/** u32 */
	flags: 100,
	params: 104,
	// shadows
	/** four mat4s */
	shadowMatrices: 108,
	shadowFade: 172,
	shadowPenumbra: 176,
	/** four vec4s */
	shadowSpheres: 180,
	shadowLook: 196,
	// weather
	/** four vec4s, see `Frame.cloud_shadow` */
	cloudShadow: 200,
	/** three vec4s, see `Frame.wetness` */
	wetness: 216,
	/** see `Frame.wind` */
	wind: 228,
} as const;

/** what {@link writeFrameUniforms} packs */
export interface FrameUniformInputs {
	/** the unjittered camera */
	camera: Camera;
	/** this frame's subpixel jitter in NDC, added to the projection */
	jitter: readonly [x: number, y: number];
	/** the render size, px */
	width: number;
	height: number;
	/** the output (canvas) size, px */
	outputWidth: number;
	outputHeight: number;
	/** the animation clock, s */
	time: number;
	/** the wind clock (`Frame.wind.x`) */
	windClock: number;
	environment: Environment;
	/** `Frame.wetness` */
	wetness: Float32Array;
	/** the linear exposure the post chain shows the scene at */
	exposure: number;
	/** which of the frame group's streamed textures are bound, and the reflection cubemap's mips */
	bindings: Pick<FrameBindings, 'has' | 'reflectionMips'>;
	/** the package's terrain, `null` (or `undefined` without a package) for none */
	terrain: TerrainInfo | null | undefined;
	/** the shadow layers as last fitted */
	shadowMap: Pick<ShadowMap, 'layers' | 'fade' | 'penumbra'>;
	/** whether the shadow layers are drawn this frame */
	shadows: boolean;
	/** each irradiance clipmap level's centre, `null` while it's not filled */
	irradiance: readonly (Vec3 | null)[];
	lights: Readonly<LocalLightFrame>;
	/** the global reveal radii the player's fire seed sets (`FireSeedInfo.radii`), `Frame.render_size.zw` */
	revealRadii: readonly [inner: number, outer: number];
	options: {
		minBoxPixels: number;
		outlineMetres: number;
		wireframe: boolean;
		cloudShadows: boolean;
		irradiance: boolean;
		debugView: DebugView;
	};
}

/** the jittered view-projection, reused across frames */
const viewProj = new Float32Array(16);

/**
 * packs one frame's uniforms.
 *
 * @param f32 the frame's block, {@link FRAME_UNIFORM_BYTES} long, as floats; fields this doesn't write keep
 *   their value
 * @param u32 the same block as integers
 * @param inputs what to pack
 */
export const writeFrameUniforms = (f32: Float32Array, u32: Uint32Array, inputs: FrameUniformInputs): void => {
	const { camera, width, height, outputWidth, outputHeight, environment, options } = inputs;
	const eye = camera.position;
	camera.writeViewProjection(width / height, viewProj);
	{
		// shift the image by this frame's subpixel jitter: clip.xy += jitter · clip.w
		const [jx, jy] = inputs.jitter;
		for (let column = 0; column < 4; column++) {
			viewProj[column * 4] += jx * viewProj[column * 4 + 3];
			viewProj[column * 4 + 1] += jy * viewProj[column * 4 + 3];
		}
	}
	f32.set(viewProj, FrameOffsets.viewProj);
	{
		const at = FrameOffsets.eye;
		f32[at] = eye[0];
		f32[at + 1] = eye[1];
		f32[at + 2] = eye[2];
		f32[at + 3] = inputs.time;
	}
	{
		f32.set(environment.sunDirection, FrameOffsets.sun);
		f32[FrameOffsets.sun + 3] = 1;
		f32.set(environment.sunIlluminance, FrameOffsets.sunColor);
		f32[FrameOffsets.sunColor + 3] = environment.sunSpecular;
		f32.set(environment.sh, FrameOffsets.sh);
		f32[FrameOffsets.ambient] = environment.indirectSpecular;
		// emitters marked `_IgnorePostExposure` divide out the post exposure (the game's adapted exposure)
		// the post chain applies, which debug views turn off
		f32[FrameOffsets.ambient + 1] = 1 / inputs.exposure;
		f32[FrameOffsets.ambient + 2] = inputs.bindings.has('reflection') ? 1 : 0;
		f32[FrameOffsets.ambient + 3] = inputs.bindings.reflectionMips;
	}
	{
		const at = FrameOffsets.viewport;
		f32[at] = outputWidth;
		f32[at + 1] = outputHeight;
		f32[at + 2] = camera.pixelFactor(outputHeight);
		f32[at + 3] = options.minBoxPixels;
	}
	const terrain = inputs.terrain;
	if (terrain != null) {
		const at = FrameOffsets.terrain;
		f32[at] = terrain.baseHeight - eye[1];
		f32[at + 1] = terrain.heightScale / TERRAIN_HOLE_BIT;
		u32[at + 2] = TERRAIN_HOLE_BIT;
	}
	{
		const at = FrameOffsets.flags;
		u32[at] = options.wireframe ? 1 : 0;
		u32[at + 1] = DEBUG_VIEWS.indexOf(options.debugView);
		u32[at + 2] = 0;
		u32[at + 3] = 0;
	}
	f32[FrameOffsets.params] = options.outlineMetres;
	// below the output size, textures sample as sharp as the output needs; the history gathers the detail
	f32[FrameOffsets.params + 1] = Math.log2(height / outputHeight);
	f32[FrameOffsets.params + 2] = environment.indirectDiffuse;
	const shadowMap = inputs.shadowMap;
	shadowMap.layers.forEach((layer, i) => {
		f32.set(layer.sample, FrameOffsets.shadowMatrices + i * 16);
		f32.set(layer.sphere, FrameOffsets.shadowSpheres + i * 4);
	});
	f32.set(shadowMap.fade, FrameOffsets.shadowFade);
	f32[FrameOffsets.shadowFade + 3] = inputs.shadows ? 1 : 0;
	{
		const shadow = environment.shadow;
		f32.set(shadowMap.penumbra(shadow.softness), FrameOffsets.shadowPenumbra);
		const at = FrameOffsets.shadowLook;
		f32[at] = shadow.strength;
		f32[at + 1] = shadow.override;
		f32[at + 2] = shadow.attenuation;
		f32[at + 3] = inputs.bindings.has('shadowRamp') ? 1 : 0;
	}
	{
		const cloud = environment.cloudShadow;
		const at = FrameOffsets.cloudShadow;
		const on =
			cloud !== null &&
			inputs.bindings.has('cloudShadow') &&
			options.cloudShadows &&
			options.debugView === 'lit';
		f32.fill(0, at, at + 16);
		if (on) {
			f32.set(cloud.center, at);
			f32[at + 3] = 1;
			f32[at + 4] = cloud.start;
			f32[at + 5] = cloud.start + cloud.width;
			f32[at + 6] = cloud.scale;
			f32.set(cloud.flow, at + 8);
			f32[at + 10] = cloud.alpha;
			f32[at + 11] = cloud.farScale;
			f32.set(cloud.projection, at + 12);
		}
	}
	f32.set(inputs.wetness, FrameOffsets.wetness);
	{
		const { wind } = environment;
		f32.set([inputs.windClock, wind.intensity, ...wind.direction], FrameOffsets.wind);
	}
	inputs.irradiance.forEach((center, i) => {
		const at = FrameOffsets.irradiance + i * 4;
		f32.set(center ?? [0, 0, 0], at);
		f32[at + 3] = center !== null && options.irradiance ? 1 : 0;
	});
	{
		const lights = inputs.lights;
		const at = FrameOffsets.localLights;
		f32[at] = lights.count;
		f32[at + 1] = lights.tilesX;
		f32[at + 2] = lights.tilesY;
		f32[at + 3] = camera.near;
		f32.set(camera.forward(), FrameOffsets.viewForward);
		f32.set(camera.right(), FrameOffsets.viewRight);
		f32.set(camera.up(), FrameOffsets.viewUp);
		f32[FrameOffsets.renderSize] = width;
		f32[FrameOffsets.renderSize + 1] = height;
		f32.set(inputs.revealRadii, FrameOffsets.renderSize + 2);
	}
};
