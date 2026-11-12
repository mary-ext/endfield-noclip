import { rideRows, ROW_BYTES, ROW_WORDS, turnRows } from '../content/instance-rows.ts';
import type { FrameSettings } from '../render/frame/frame-graph.ts';
import { offscreenCasters } from '../render/shadows/shadow-map.ts';
import type { Camera, Plane } from '../scene/camera.ts';
import type { MeshSelection } from '../streaming/mesh-selection.ts';
import type { ResidentInstances } from '../streaming/resident.ts';
import type { InstanceRange } from '../streaming/selection.ts';
import { TextureReduction } from '../streaming/texture-reduction.ts';

import type { EnvironmentLook } from './environment-state.ts';
import type { ViewerOptions } from './options.ts';
import type { Renderer } from './renderer.ts';
import type { LoadedScene } from './scene-loader.ts';
import { updateSkyTextures } from './sky-textures.ts';
import type { FrameTimes } from './stats.ts';

/** what one traversal selects for */
export interface TraversalInput {
	camera: Camera;
	options: ViewerOptions;
	settings: FrameSettings;
	look: EnvironmentLook;
	/** the focused level's cells, whose content is boosted, or `null` */
	focusCells: Set<string> | null;
	/** the frame counter */
	index: number;
	/** the animation clock, s */
	time: number;
	/** water volumes' current offsets, by volume */
	waterOffsets: Float32Array;
	/** write the selection for the renderers too: the frame renders */
	prepare: boolean;
	times: FrameTimes;
}

/**
 * one frame's selection and streaming: walks the tile tree, moves spinning and riding rows, selects mesh
 * LODs, requests sky, water and irradiance textures, updates the stream, and when the frame renders, writes
 * the selection for the renderers
 */
export class Traversal {
	/** the stream version as the last traversal began; a later one means content changed since */
	seenVersion = -1;
	/** tree nodes the last traversal visited */
	visited = 0;
	/** whether the last mesh selection drew particles, which frames of a still view re-evaluate */
	particlesShown = false;
	/**
	 * whether the last selection held spinning or riding rows, which move by the clock while the view holds
	 * still
	 */
	movingShown = false;
	/** lowers material texture resolution while the stream budget is full */
	readonly textureReduction = new TextureReduction();
	/** the frustum planes, rewritten each traversal */
	readonly #planes: Plane[] = [];
	/** the clock each resident block's spinning and riding rows were last moved to */
	readonly #movedTimes = new WeakMap<ResidentInstances, number>();
	readonly #renderer: Renderer;

	/** @param renderer the renderers the selection is written for */
	constructor(renderer: Renderer) {
		this.#renderer = renderer;
	}

	/**
	 * @param scene the loaded package
	 * @param input what to select for
	 */
	run(scene: LoadedScene, input: TraversalInput): void {
		const { camera, options, settings, times } = input;
		const renderer = this.#renderer;
		const { targets, terrain, instances, meshes, water } = renderer;
		const stream = scene.stream;
		stream.beginFrame(input.index);
		this.seenVersion = stream.version;
		// screen-space sizes are measured in output pixels, so the render scale trades shading only, not detail
		const aspect = targets.outputWidth / targets.outputHeight;
		const planes = camera.frustumPlanes(aspect, this.#planes);
		const { shadows } = settings;
		const { environment, celestial } = input.look;
		const view = {
			camera,
			planes,
			pixelFactor: camera.pixelFactor(targets.outputHeight),
			// with the lights whose shadow tiles wait for their casters, which this selection then covers
			casters: shadows
				? offscreenCasters(planes, environment.sunDirection, renderer.lights.shadows.casterSpheres())
				: null,
		};
		const selection = scene.selector.run(
			view,
			{
				...options,
				terrainSurface: options.terrainSurface && terrain.surfaces,
				terrainSplat: options.terrainSplat && terrain.surfaces,
			},
			input.focusCells,
		);
		this.visited = selection.visited;
		// spinning and riding rows move before instances are culled and listed by where they are
		this.movingShown = this.#moveRows(selection.instances, input.time);
		times.span('tree');
		// per-instance LOD selection also requests geometry, so it runs before the stream update; it groups
		// instances by the shadow layers they reach, as fitted for this frame
		let meshSelection: MeshSelection | null = null;
		if (scene.meshes !== null && options.instances) {
			meshSelection = scene.meshes.run(selection.instances, {
				eye: camera.position,
				planes: view.planes,
				pixelFactor: view.pixelFactor,
				viewportHeight: targets.outputHeight,
				minPixels: options.minBoxPixels,
				textureBias: options.textureBias + this.textureReduction.levels,
				unsupportedMaterials: options.unsupportedMaterials,
				missingContent: options.missingContent,
				gpuCulling: options.gpuCulling && meshes.gpuCulling,
				mips: options.mipFeedback && targets.scene.mipFeedback !== null ? meshes.mips : null,
				casters: view.casters,
				shadowLayers: shadows ? renderer.shadows.volumes : null,
				// particles move by the clock the effects' shaders scroll by
				particles: {
					time: input.time,
					eye: camera.position,
					widthPerDepth: 2 * Math.tan(camera.fovY / 2) * aspect,
					right: camera.right(),
					up: camera.up(),
					forward: camera.forward(),
				},
			});
		}
		this.particlesShown = meshSelection?.particles ?? false;
		times.span('mesh select');
		updateSkyTextures(
			{ stream, textures: scene.textures, flowNoise: scene.pkg.environment.flowNoise },
			{ environment, celestial, flowNoise: options.flowNoise },
			{ post: renderer.post, bindings: renderer.bindings },
		);
		if (options.water) {
			water.prepare({
				eye: camera.position,
				planes: view.planes,
				stream,
				geometries: scene.pkg.geometries,
				textures: scene.textures,
				sun: environment.sunRaw,
				volumeOffsets: input.waterOffsets,
			});
		} else {
			water.clear();
		}
		times.span('sky, water');
		renderer.irradiance.prepare(stream, camera.position);
		stream.update();
		this.textureReduction.update(stream, input.index, stream.options.budgetBytes);
		scene.textures.commit();
		times.span('stream');
		if (!input.prepare) {
			return;
		}

		const eye = camera.position;
		terrain.prepare(options.terrain ? selection.patches : [], eye, shadows ? renderer.shadows.volumes : null);
		instances.rebase(eye);
		if (meshSelection === null) {
			instances.prepareRanges(options.instances && options.boxes ? selection.instances : []);
			meshes.clear();
		} else {
			const spans = instances.prepareList(options.boxes ? meshSelection.boxes : [], meshSelection.buckets);
			meshes.prepare(meshSelection.buckets, spans, scene.textures, meshSelection.gpu);
		}
		renderer.frame.shadowLayers.invalidate();
		times.span('prepare');
	}

	/**
	 * turns the spinning rows of the selected blocks, and moves their riding rows, to the clock and rewrites
	 * them
	 *
	 * @param ranges the selected instance ranges
	 * @param time the animation clock, s
	 * @returns whether any selected block has spinning or riding rows
	 */
	#moveRows(ranges: readonly InstanceRange[], time: number): boolean {
		let shown = false;
		for (const { item } of ranges) {
			const resident = item.resident;
			if (resident?.kind !== 'instances' || (resident.spins === null && resident.rides === null)) {
				continue;
			}
			shown = true;
			if (this.#movedTimes.get(resident) === time) {
				continue;
			}
			this.#movedTimes.set(resident, time);
			if (resident.spins !== null) {
				turnRows(resident.rowsF32, resident.spins, time);
				this.#writeRuns(resident, resident.spins.runs);
			}
			if (resident.rides !== null) {
				rideRows(resident.rowsF32, resident.rides, time);
				this.#writeRuns(resident, resident.rides.runs);
			}
		}
		return shown;
	}

	/**
	 * @param resident a block whose rows changed on the CPU
	 * @param runs (first, end) pairs of the row ranges to upload
	 */
	#writeRuns(resident: ResidentInstances, runs: Uint32Array): void {
		for (let r = 0; r < runs.length; r += 2) {
			const first = runs[r];
			const count = runs[r + 1] - first;
			this.#renderer.instances.writeRows(
				resident.alloc.start + first,
				new Uint32Array(resident.rowsF32.buffer, first * ROW_BYTES, count * ROW_WORDS),
				count,
			);
		}
	}
}
