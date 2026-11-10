/**
 * the passes of a frame, in order, from the irradiance update to the swapchain. which passes run and what
 * they bind is in docs/viewer/frame.md.
 *
 * @module
 */

import type { Camera } from '../../scene/camera.ts';
import type { InstanceRenderer } from '../instances/instance-renderer.ts';
import type { IrradianceVolume } from '../lighting/irradiance-volume.ts';
import type { LightShadows } from '../lighting/light-shadows.ts';
import type { MeshRenderer } from '../meshes/mesh-renderer.ts';
import type { PostProcess } from '../post/post-process.ts';
import { type PostSettings, effectiveSettings } from '../post/settings.ts';
import { SHADOW_LAYERS, type ShadowMap } from '../shadows/shadow-map.ts';
import type { VolumetricFog } from '../sky/volumetric-fog.ts';
import type { TerrainRenderer } from '../terrain/terrain-renderer.ts';
import type { WaterRenderer } from '../water/water-renderer.ts';

import type { DebugView } from './debug-views.ts';
import type { RenderTargets } from './render-targets.ts';

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
	/** the main pass's frame group */
	frame: FrameGroup;
	/** the shadow passes' frame group, and each shadow layer's uniforms offset (none when shadows are off) */
	shadowFrame: { group: GPUBindGroup; offsets: readonly number[] };
	/** the frame group of the local-light shadow tile drawn this frame, or `null` for none */
	lightShadowFrame: FrameGroup | null;
	/** the frame counter, which the fog's noise steps by */
	index: number;
	/** the animation clock, s */
	time: number;
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
	terrain: TerrainRenderer;
	instances: InstanceRenderer;
	meshes: MeshRenderer;
	fog: VolumetricFog;
	water: WaterRenderer;
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
		let sharp = this.#stale;
		const renders = this.#renders;
		for (let i = 0; i < far; i++) {
			const render = layers[i].render;
			if (render.some((value, k) => value !== renders[i * 16 + k])) {
				renders.set(render, i * 16);
				sharp = true;
			}
		}
		const fit = layers[far].fit;
		let farDraw = this.#farStale && this.#farAge + 1 >= FAR_LAYER_INTERVAL;
		if (fit.some((value, k) => value !== this.#farFit[k])) {
			this.#farFit.set(fit);
			farDraw = true;
		}
		// an animated caster moves whenever the clock does; the far layer, like the game's far map, holds still ones
		sharp ||= frame.skinned;
		draw.fill(sharp, 0, far);
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
	const { targets, meshes, post, water } = systems;
	const { camera, width, height, outputWidth, outputHeight, settings } = context;
	const sceneFrame = settings.scene ? context.frame : null;
	let draws = 0;

	systems.irradiance.encode(encoder);
	const skinned = settings.scene && meshes.animate(encoder, context.time);
	if (settings.scene) {
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
		context.shadowFrame.offsets.forEach((offset, i) => {
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
				{ group: context.shadowFrame.group, offset },
			);
			if (settings.terrain) {
				draws += systems.terrain.encodeShadow(pass, i);
			}
			draws += meshes.encodeShadow(pass, i);
			pass.end();
		});
	}

	// one tile of the local lights' atlas, from the casters the far layer draws: static scenery
	const lightShadowFrame = context.lightShadowFrame;
	if (lightShadowFrame !== null) {
		const far = SHADOW_LAYERS - 1;
		draws += systems.lightShadows.encode(
			encoder,
			(pass) => pass.setBindGroup(0, lightShadowFrame.group, [lightShadowFrame.offset]),
			(pass) =>
				(settings.terrain ? systems.terrain.encodeShadow(pass, far) : 0) + meshes.encodeShadow(pass, far),
		);
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
			sceneFrame,
		);
		if (settings.scene) {
			for (const step of MAIN_PASS) {
				draws += step(pass, systems, context);
			}
		}
		pass.end();
	}
	const scene = targets.scene;
	if (sceneFrame !== null) {
		const pass = beginPass(
			encoder,
			{
				label: 'decal relight',
				colorAttachments: [{ view: scene.radiance, loadOp: 'load', storeOp: 'store' }],
			},
			sceneFrame,
		);
		draws += meshes.encodeEffectPass('relight', pass, scene);
		pass.end();
	}
	const composited = post.encodeComposite(encoder, {
		scene,
		camera,
		width,
		height,
		outputWidth,
		outputHeight,
		settings: settings.post,
		time: context.time,
		frame: context.index,
		froxels,
		water,
		frameGroup: context.frame,
	});
	// the water and effects that refract read a copy of the composited scene
	if (composited.water !== null) {
		post.copyComposite(encoder, scene);
		const foam = sceneFrame !== null && meshes.has('waterFoam');
		if (foam) {
			// the foam boxes project onto the water's own depth
			const pass = beginPass(
				encoder,
				{
					label: 'water foam',
					colorAttachments: [
						{
							view: water.foamTarget(composited.water),
							clearValue: [0, 0, 0, 1],
							loadOp: 'clear',
							storeOp: 'store',
						},
					],
					depthStencilAttachment: targets.readOnlyDepthAttachment(),
				},
				sceneFrame,
			);
			draws += meshes.encodeEffectPass('waterFoam', pass, { ...scene, depth: scene.waterDepth });
			pass.end();
		}
		water.encode(encoder, composited.target, { ...composited.water, foam });
	}
	if (sceneFrame !== null) {
		// effects over the composited scene
		const over = (label: string): GPURenderPassDescriptor => ({
			label,
			colorAttachments: [{ view: composited.target, loadOp: 'load', storeOp: 'store' }],
			depthStencilAttachment: targets.readOnlyDepthAttachment(),
		});
		// as the game, glass and effects after the water, far to near over the scene, each fogging itself
		if (meshes.has('transparent')) {
			const pass = beginPass(
				encoder,
				{
					label: 'transparent',
					colorAttachments: [{ view: composited.target, loadOp: 'load', storeOp: 'store' }],
					depthStencilAttachment: targets.transparentDepthAttachment(),
				},
				sceneFrame,
			);
			draws += meshes.encodeEffectPass('transparent', pass, scene);
			pass.end();
		}
		if (meshes.has('multiply')) {
			const pass = beginPass(encoder, over('effect multiply'), sceneFrame);
			draws += meshes.encodeEffectPass('multiply', pass, scene);
			pass.end();
		}
		if (meshes.has('refract')) {
			// refraction samples the scene as the multiplies left it
			post.copyComposite(encoder, scene);
			const pass = beginPass(encoder, over('effect refract'), sceneFrame);
			draws += meshes.encodeEffectPass('refract', pass, { ...scene, background: scene.radiance });
			pass.end();
		}
	}
	post.encodeAfterScene(encoder, {
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
