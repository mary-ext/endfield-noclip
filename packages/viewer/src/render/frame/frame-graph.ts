/**
 * the passes of a frame, in order, from the irradiance update to the swapchain. which passes run and what
 * they bind is in docs/viewer/frame.md.
 *
 * @module
 */

import type { Environment } from '../../environment/environment.ts';
import type { Camera } from '../../scene/camera.ts';
import { SHADOW_LAYERS } from '../../scene/shadow-volumes.ts';
import { CAMERA_HISTORY_FLOATS } from '../core/camera-history.ts';
import type { RenderTargets } from '../core/render-targets.ts';
import { type DebugView, type PostSettings, effectiveSettings } from '../core/settings.ts';
import type { InstanceRenderer } from '../instances/instance-renderer.ts';
import type { IrradianceVolume } from '../lighting/irradiance-volume.ts';
import type { LightShadows } from '../lighting/light-shadows.ts';
import type { ShadowMap } from '../lighting/shadow-map.ts';
import type { ClothSimulator } from '../meshes/cloth-simulator.ts';
import type { MeshRenderer } from '../meshes/mesh-renderer.ts';
import type { PostProcess } from '../post/post-process.ts';
import type { VolumetricFog } from '../sky/volumetric-fog.ts';
import type { TerrainRenderer } from '../terrain/terrain-renderer.ts';
import type { WaterContext, WaterRenderer } from '../water/water-renderer.ts';
import type { VerticalOcclusionMap } from '../weather/vertical-occlusion.ts';
import type { WeatherRenderer } from '../weather/weather-renderer.ts';

import type { SceneComposer } from './scene-composer.ts';

/** scratch camera history for water reflections, reused across frames */
const waterReprojection = new Float32Array(CAMERA_HISTORY_FLOATS);

/** a frame group and its uniforms' dynamic offset */
export interface FrameGroup {
	group: GPUBindGroup;
	offset: number;
}

/** what a frame draws, from the options in effect: debug views turn the lit-only passes off */
export interface FrameSettings {
	/** a package is loaded */
	scene: boolean;
	/** the lit image, not a debug view */
	lit: boolean;
	/** the shadow layers are drawn and sampled */
	shadows: boolean;
	/** surfaces and the fog are lit by the package's local lights */
	localLights: boolean;
	/** the volumetric fog is computed */
	volumetricFog: boolean;
	/** falling rain, splashes, snow, and weather vertical occlusion are enabled */
	weather: boolean;
	terrain: boolean;
	wireframe: boolean;
	/** rows in view hidden behind last frame's depth skip the main pass (`occlusionCulling`) */
	occlusionCulling: boolean;
	/** the post chain's settings, as {@link effectiveSettings} leaves them */
	post: PostSettings;
}

/**
 * @param options the viewer's options
 * @param scene whether a package is loaded
 * @param post the post chain's settings asked for
 * @returns what the frame draws
 */
export const frameSettings = (
	options: {
		debugView: DebugView;
		shadows: boolean;
		localLights: boolean;
		heightFog: boolean;
		weather: boolean;
		terrain: boolean;
		wireframe: boolean;
		occlusionCulling: boolean;
	},
	scene: boolean,
	post: PostSettings,
): FrameSettings => {
	const lit = options.debugView === 'lit';
	return {
		scene,
		lit,
		shadows: scene && lit && options.shadows,
		localLights: scene && lit && options.localLights,
		volumetricFog: scene && lit && options.heightFog,
		weather: scene && lit && options.weather,
		terrain: options.terrain,
		wireframe: options.wireframe,
		occlusionCulling: options.occlusionCulling,
		post: effectiveSettings(post),
	};
};

/** one frame's view, groups and settings, shared by every pass */
export interface FrameContext {
	/** the unjittered camera */
	camera: Camera;
	/** the render size, px */
	width: number;
	height: number;
	/** the output (canvas) size, px */
	outputWidth: number;
	outputHeight: number;
	/** the uniform-only frame group (G-buffer, depth, shadow, decal, foam and screen-effect passes) */
	frameCore: FrameGroup;
	/** the full lighting frame group (deferred lighting, fog, water, transparents, lit effects) */
	frame: FrameGroup;
	/** each shadow layer's uniforms offset (empty when shadows are off); bound with `frameCore.group` */
	shadowOffsets: readonly number[];
	/** the uniforms offset of the local-light shadow tile drawn this frame, or `null` for none */
	lightShadowOffset: number | null;
	/** the uniforms offset of the vertical occlusion pass drawn this frame, or `null` for none */
	verticalOcclusionOffset: number | null;
	/** the frame counter, which the fog's noise steps by */
	index: number;
	/** the animation clock, s */
	time: number;
	/** frame delta for GPU simulations, s (0 when paused) */
	dt: number;
	/** current environment wind */
	wind: Environment['wind'];
	settings: FrameSettings;
	/** whether pipelines are still compiling, which would leave shadow casters out */
	compiling: boolean;
}

/** the systems whose passes a frame encodes */
export interface FrameSystems {
	targets: RenderTargets;
	irradiance: IrradianceVolume;
	shadowMap: ShadowMap;
	shadowLayers: ShadowLayerCache;
	lightShadows: LightShadows;
	verticalOcclusion: VerticalOcclusionMap;
	terrain: TerrainRenderer;
	instances: InstanceRenderer;
	cloth: ClothSimulator;
	meshes: MeshRenderer;
	fog: VolumetricFog;
	water: WaterRenderer;
	weather: WeatherRenderer;
	composer: SceneComposer;
	post: PostProcess;
}

/** a contribution to the main pass, returning its draws */
type MainPassStep = (pass: GPURenderPassEncoder, systems: FrameSystems, context: FrameContext) => number;

/**
 * what the main pass draws, in order: the meshes' depth first, so the terrain and the meshes shade only what
 * stays visible
 */
const MAIN_PASS: readonly MainPassStep[] = [
	(pass, { meshes }) => meshes.encodePass('prepass', pass),
	(pass, { terrain }) => terrain.encode(pass),
	(pass, { meshes }) => meshes.encodePass('main', pass),
	(pass, { instances }) => instances.encode(pass),
	(pass, { instances }) => instances.encodeOutlines(pass),
	(pass, { terrain }, { settings }) => (settings.wireframe ? terrain.encodeWireframe(pass) : 0),
	(pass, { meshes }, { frame }) => {
		if (!meshes.has('effectOpaque')) {
			return 0;
		}
		pass.setBindGroup(0, frame.group, [frame.offset]);
		return meshes.encodePass('effectOpaque', pass);
	},
];

/** frames the far layer may keep casters that changed before it's drawn again with them */
const FAR_LAYER_INTERVAL = 8;

/**
 * which shadow layers need drawing. they hold what they drew last until the casters or their fit change, so
 * frames that only settle the antialiasing or drift the fog redraw nothing there. the sharp cascades redraw
 * whenever either changes, as the game redraws its cascades every frame; the far layer, which keeps its fit
 * until the camera crosses a cell of its grid, redraws when its fit moves and otherwise takes changed casters
 * at most every {@link FAR_LAYER_INTERVAL} frames, as the game's cached far map re-renders a few tiles a
 * frame
 */
export class ShadowLayerCache {
	/** the casters changed, or the sharp cascades weren't drawn last frame */
	#stale = true;
	/** the casters changed since the far layer was drawn, or it must be drawn */
	#farStale = true;
	/** frames since the far layer was drawn */
	#farAge = 0;
	/** each sharp cascade's render matrix when it was last drawn */
	readonly #renders = new Float32Array(16 * (SHADOW_LAYERS - 1));
	/** the far layer's fit when it was last drawn */
	readonly #farFit = new Float64Array(4);
	/** which layers to draw, reused */
	readonly #draw: boolean[] = Array.from({ length: SHADOW_LAYERS }, () => false);

	/** marks the casters changed: a new selection was prepared */
	invalidate(): void {
		this.#stale = true;
		this.#farStale = true;
	}

	/**
	 * @param layers the layers as fitted this frame
	 * @param frame whether shadows draw, whether an animated caster moved, and whether pipelines are compiling
	 * @returns per layer, whether to draw it this frame (the same array every frame)
	 */
	update(
		layers: ShadowMap['layers'],
		frame: { shadows: boolean; skinned: boolean; compiling: boolean },
	): readonly boolean[] {
		const draw = this.#draw;
		if (!frame.shadows) {
			draw.fill(false);
			this.#stale = true;
			this.#farStale = true;
			this.#farFit.fill(Number.NaN);
			return draw;
		}
		const far = SHADOW_LAYERS - 1;
		const baseSharp = this.#stale || frame.skinned;
		const renders = this.#renders;
		for (let i = 0; i < far; i++) {
			const render = layers[i].render;
			const base = i * 16;
			let moved = false;
			for (let k = 0; k < 16; k++) {
				if (render[k] !== renders[base + k]) {
					renders[base + k] = render[k];
					moved = true;
				}
			}
			draw[i] = baseSharp || moved;
		}
		const fit = layers[far].fit;
		let farDraw = this.#farStale && this.#farAge + 1 >= FAR_LAYER_INTERVAL;
		for (let k = 0; k < 4; k++) {
			if (fit[k] !== this.#farFit[k]) {
				this.#farFit[k] = fit[k];
				farDraw = true;
			}
		}
		draw[far] = farDraw;
		// pipelines still compiling would leave casters out
		this.#stale = frame.compiling;
		if (farDraw) {
			this.#farAge = 0;
			this.#farStale = frame.compiling;
		} else {
			this.#farAge++;
		}
		return draw;
	}
}

/**
 * begins a render pass and binds group 0
 *
 * @param encoder this frame's encoder
 * @param descriptor the pass
 * @param frame the frame group to bind, or `null` for none
 * @returns the pass
 */
const beginPass = (
	encoder: GPUCommandEncoder,
	descriptor: GPURenderPassDescriptor,
	frame: FrameGroup | null,
): GPURenderPassEncoder => {
	const pass = encoder.beginRenderPass(descriptor);
	if (frame !== null) {
		pass.setBindGroup(0, frame.group, [frame.offset]);
	}
	return pass;
};

/**
 * encodes one frame's passes, from the irradiance update to the swapchain
 *
 * @param encoder this frame's encoder; the frame uniforms are already written
 * @param context the frame's view, groups and settings
 * @param systems the systems whose passes run
 * @returns the draws encoded
 */
export const encodeFrame = (
	encoder: GPUCommandEncoder,
	context: FrameContext,
	systems: FrameSystems,
): number => {
	const { targets, meshes, composer, post, water } = systems;
	const { camera, width, height, outputWidth, outputHeight, settings } = context;
	const sceneCore = settings.scene ? context.frameCore : null;
	const sceneFrame = settings.scene ? context.frame : null;
	let draws = 0;

	systems.irradiance.encode(encoder);
	const skinned = settings.scene && meshes.animate(encoder, context.time);
	if (settings.scene) {
		systems.cloth.step(encoder, context.dt, context.wind);
		meshes.cull(encoder, {
			camera,
			aspect: width / height,
			depth: { view: targets.scene.depth, width, height },
			occlusion: settings.occlusionCulling,
		});
	}
	const drawShadows = systems.shadowLayers.update(systems.shadowMap.layers, {
		shadows: settings.shadows,
		skinned,
		compiling: context.compiling,
	});
	if (drawShadows.includes(true)) {
		context.shadowOffsets.forEach((offset, i) => {
			if (!drawShadows[i]) {
				return;
			}
			const pass = beginPass(
				encoder,
				{
					label: `shadow layer ${i}`,
					colorAttachments: [],
					depthStencilAttachment: {
						view: systems.shadowMap.views[i],
						depthClearValue: 1,
						depthLoadOp: 'clear',
						depthStoreOp: 'store',
					},
				},
				{ group: context.frameCore.group, offset },
			);
			if (settings.terrain) {
				draws += systems.terrain.encodeShadow(pass, i);
			}
			draws += meshes.encodeShadow(pass, i);
			pass.end();
		});
	}

	// one tile of the local lights' atlas, from the casters the far layer draws: static scenery
	const lightShadowOffset = context.lightShadowOffset;
	if (lightShadowOffset !== null) {
		const far = SHADOW_LAYERS - 1;
		draws += systems.lightShadows.encode(
			encoder,
			(pass) => pass.setBindGroup(0, context.frameCore.group, [lightShadowOffset]),
			(pass) =>
				(settings.terrain ? systems.terrain.encodeLightShadow(pass, far) : 0) +
				meshes.encodeLightShadow(pass, far),
		);
	}

	// top-down vertical occlusion depth map for rain wetness, falling rain, splashes, and snow
	const verticalOcclusionOffset = context.verticalOcclusionOffset;
	if (verticalOcclusionOffset !== null) {
		const far = SHADOW_LAYERS - 1;
		const pass = beginPass(
			encoder,
			{
				label: 'vertical occlusion',
				colorAttachments: [],
				depthStencilAttachment: {
					view: systems.verticalOcclusion.view,
					depthClearValue: 1,
					depthLoadOp: 'clear',
					depthStoreOp: 'store',
				},
			},
			{ group: context.frameCore.group, offset: verticalOcclusionOffset },
		);
		if (settings.terrain) {
			draws += systems.terrain.encodeLightShadow(pass, far);
		}
		draws += meshes.encodeLightShadow(pass, far);
		pass.end();
	}

	// after the shadow maps, which it reads
	const froxels =
		settings.volumetricFog &&
		systems.fog.encode(encoder, {
			frameGroup: context.frame.group,
			frameOffset: context.frame.offset,
			camera,
			aspect: width / height,
			frame: context.index,
		});

	{
		const { colors, depth } = targets.mainPassAttachments();
		const pass = beginPass(
			encoder,
			{ label: 'main', colorAttachments: colors, depthStencilAttachment: depth },
			sceneCore,
		);
		if (settings.scene) {
			for (const step of MAIN_PASS) {
				draws += step(pass, systems, context);
			}
		}
		pass.end();
	}
	const scene = targets.scene;
	if (settings.scene) {
		meshes.encodeMipFeedback(encoder, { view: scene.mipFeedback, width, height }, context.index);
	}
	// `HGRP/DecalLit` boxes blend directly into the G-buffer before AO, SSR and deferred lighting
	if (sceneCore !== null && meshes.has('decals')) {
		const copies = targets.copyGBufferAB(encoder);
		const pass = beginPass(
			encoder,
			{
				label: 'lit decals',
				colorAttachments: [
					{ view: scene.emission, loadOp: 'load', storeOp: 'store' },
					{ view: scene.gbufferA, loadOp: 'load', storeOp: 'store' },
					{ view: scene.gbufferB, loadOp: 'load', storeOp: 'store' },
					{ view: scene.gbufferC, loadOp: 'load', storeOp: 'store' },
				],
			},
			sceneCore,
		);
		draws += meshes.encodeEffectPass('decals', pass, {
			...scene,
			gbufferA: copies.gbufferA,
			gbufferB: copies.gbufferB,
			// distinct cache key from the live G-buffer views
			version: -scene.version,
		});
		pass.end();
	}
	// `HGRP/WetnessDecal` boxes max-blend into `wetnessMask`; skip the clear pass once it is already zeroed
	{
		const hasWetness = sceneCore !== null && meshes.has('wetnessDecals');
		if (hasWetness || !targets.wetnessMaskClean) {
			const pass = beginPass(
				encoder,
				{
					label: 'wetness decals',
					colorAttachments: [
						{ view: scene.wetnessMask, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' },
					],
				},
				hasWetness ? sceneCore : null,
			);
			if (hasWetness) {
				draws += meshes.encodeEffectPass('wetnessDecals', pass, scene);
			}
			pass.end();
			targets.wetnessMaskClean = !hasWetness;
		}
	}
	const composited = composer.ensureTarget(scene, width, height);
	const { resized, historyViews } = post.ensureSized(scene, {
		composited: composited.view,
		width,
		height,
		outputWidth,
		outputHeight,
	});
	if (resized) {
		composer.resizePasses(scene, { width, height, target: composited.view, historyViews });
	}
	composer.encodePreDeferred(encoder, {
		camera,
		width,
		height,
		time: context.time,
		frame: context.index,
		jitter: post.jitter,
		exposure: post.exposure(settings.post),
		settings: settings.post,
		froxels,
		previousScene: post.previousIndex,
	});
	let waterContext: WaterContext | null = null;
	if (settings.lit && water.active) {
		const reflectionScene = post.previousScene(waterReprojection, camera.position);
		waterContext = {
			scene,
			background: scene.lit,
			reflectionScene,
			reprojection: waterReprojection,
			frame: context.frame,
			postUniforms: composer.skyLayoutGroups.uniforms,
			sky: composer.skyLayoutGroups.sky,
			version: composited.version,
			width,
			height,
			foam: false,
		};
	}
	if (waterContext !== null) {
		draws += water.encodeDepth(encoder, waterContext);
	} else {
		water.clearDepth(encoder, scene);
	}
	composer.encodeDeferredAndComposite(encoder, context.frame);
	/** a pass over the composited scene, testing the main pass's depth */
	const over = (label: string): GPURenderPassDescriptor => ({
		label,
		colorAttachments: [{ view: composited.view, loadOp: 'load', storeOp: 'store' }],
		depthStencilAttachment: targets.readOnlyDepthAttachment(),
	});
	// the water and effects that refract read a copy of the composited scene
	if (waterContext !== null) {
		composer.copyComposite(encoder, scene);
		const foam = sceneCore !== null && meshes.has('waterFoam');
		if (foam) {
			// the foam boxes project onto the water's own depth and are depth-tested against it, as the game tests
			// them against its depth with the water in it
			const pass = beginPass(
				encoder,
				{
					label: 'water foam',
					colorAttachments: [
						{
							view: water.foamTarget(waterContext),
							clearValue: [0, 0, 0, 1],
							loadOp: 'clear',
							storeOp: 'store',
						},
					],
					depthStencilAttachment: targets.readOnlyWaterDepthAttachment(),
				},
				sceneCore,
			);
			draws += meshes.encodeEffectPass('waterFoam', pass, { ...scene, depth: scene.waterDepth });
			pass.end();
		}
		draws += water.encode(encoder, composited.view, { ...waterContext, foam });
	}
	if (sceneFrame !== null && sceneCore !== null) {
		// as the game, glass and effects after the water, far to near over the scene, each fogging itself
		if (meshes.has('transparent')) {
			if (meshes.transparentReadsBackground) {
				composer.copyComposite(encoder, scene);
			}
			const writesDepth = meshes.transparentWritesDepth;
			const depth = writesDepth ? targets.copyDepth(encoder) : scene.depth;
			const pass = beginPass(
				encoder,
				{
					label: 'transparent',
					colorAttachments: [{ view: composited.view, loadOp: 'load', storeOp: 'store' }],
					depthStencilAttachment: writesDepth
						? targets.writableTransparentDepthAttachment()
						: targets.transparentDepthAttachment(),
				},
				sceneFrame,
			);
			draws += meshes.encodeEffectPass('transparent', pass, {
				...scene,
				depth,
				background: scene.lit,
				// distinct cache key from `scene.depth` so effect bind groups don't reuse the live depth view
				version: writesDepth ? -scene.version : scene.version,
			});
			pass.end();
		}
		if (meshes.has('multiply')) {
			const pass = beginPass(encoder, over('effect multiply'), sceneFrame);
			draws += meshes.encodeEffectPass('multiply', pass, scene);
			pass.end();
		}
		const opaqueRefract = meshes.has('refractOpaque');
		if (opaqueRefract || meshes.has('refract')) {
			// refraction samples the scene as the multiplies left it; as the game's distortion pass, both lists
			// sample the one copy
			composer.copyComposite(encoder, scene);
			const inputs = { ...scene, background: scene.lit };
			if (opaqueRefract) {
				const pass = beginPass(
					encoder,
					{
						label: 'effect refract opaque',
						colorAttachments: [{ view: composited.view, loadOp: 'load', storeOp: 'store' }],
						depthStencilAttachment: targets.writableDepthAttachment(),
					},
					sceneCore,
				);
				draws += meshes.encodeEffectPass('refractOpaque', pass, inputs);
				pass.end();
			}
			if (meshes.has('refract')) {
				const pass = beginPass(encoder, over('effect refract'), sceneCore);
				draws += meshes.encodeEffectPass('refract', pass, inputs);
				pass.end();
			}
		}
		if (settings.weather && systems.weather.active) {
			const pass = beginPass(encoder, over('weather'), sceneFrame);
			draws += systems.weather.encode(pass, scene);
			pass.end();
		}
	}
	post.encode(encoder, {
		swapchain: targets.swapchainView(),
		camera,
		width,
		height,
		outputWidth,
		outputHeight,
		settings: settings.post,
	});
	return draws;
};
