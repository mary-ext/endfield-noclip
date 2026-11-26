/**
 * draws the sky beyond the atmosphere ({@link CelestialLook}) at the sky pixels in the celestial pass
 * (celestial-shader.ts), for the composite to put over the atmosphere's sky. the uniforms are written each
 * frame, since the ray-traced planet is placed relative to the camera.
 *
 * @module
 */

import type { Vec3 } from '@endfield-noclip/package-format/values';

import { type TgpuBindGroup, type TgpuRenderPipeline, type TgpuRoot, common, d } from 'typegpu';

import {
	CELESTIAL_TEXTURE_SLOTS,
	type CelestialLook,
	type CelestialTextureSlot,
	NO_CELESTIAL,
} from '../../environment/celestial-look.ts';
import { createUniformBuffer, rowWriter } from '../../gfx/buffers.ts';
import type { AsyncPipeline, PipelineCache } from '../../gfx/pipeline-cache.ts';
import { placeholder } from '../../gfx/placeholders.ts';
import { LINEAR_REPEAT_MIPMAPPED, NEAREST_REPEAT, sampler } from '../../gfx/samplers.ts';
import { type TgpuFullscreenPass, encodeTgpuFullscreen } from '../../gfx/tgpu-fullscreen.ts';
import { postUniformLayout } from '../core/post-schema.ts';
import { HDR_FORMAT } from '../core/render-targets.ts';
import type { TextureBinding } from '../textures/texture-store.ts';

import {
	CelestialSchema,
	SkyPlanetSchema,
	celestialLayerLayout,
	celestialSceneLayout,
	fsCelestial,
} from './celestial-shader.ts';

/** byte size and float offsets derived from {@link CelestialSchema} */
const UNIFORM_BYTES = d.sizeOf(CelestialSchema);
const STAR_OFFSET = d.memoryLayoutOf(CelestialSchema, (s) => s.stars).offset / 4;
const RAY_OFFSET = d.memoryLayoutOf(CelestialSchema, (s) => s.ray).offset / 4;
const SKY_OFFSET = d.memoryLayoutOf(CelestialSchema, (s) => s.sky).offset / 4;
const SKY_STRIDE = d.sizeOf(SkyPlanetSchema) / 4;
const SUN_OFFSET = d.memoryLayoutOf(CelestialSchema, (s) => s.sunDirection).offset / 4;

/**
 * owns the celestial pass, which draws the layers at the sky pixels into the main pass's sky reflection
 * target for the composite: its uniforms, samplers and bound textures
 */
export class CelestialLayer {
	#root: TgpuRoot;
	#pipeline: AsyncPipeline<TgpuRenderPipeline>;
	#postGroup: TgpuBindGroup;
	#uniforms: GPUBuffer;
	#data = new Float32Array(UNIFORM_BYTES / 4);
	#words = new Uint32Array(this.#data.buffer);
	#sampler: GPUSampler;
	#pointSampler: GPUSampler;
	/** black, for slots without a texture */
	#black: GPUTextureView;
	#views = new Map<CelestialTextureSlot, GPUTextureView>();
	#look: CelestialLook = NO_CELESTIAL;
	/** group 1, rebuilt when a texture changes */
	#layerGroup: TgpuBindGroup;
	/** the cloud panorama bound in group 2 */
	#cloud: TextureBinding;
	#noCloud: TextureBinding;
	/** the main pass's depth and the target, plus its fullscreen pass, once sized */
	#sized: {
		depth: GPUTextureView;
		target: GPUTextureView;
		sceneGroup: TgpuBindGroup;
		pass: TgpuFullscreenPass;
	} | null = null;

	/**
	 * @param root the TypeGPU root
	 * @param pipelines the pipeline cache
	 * @param input the post chain's `Post` uniforms, and the bilinear clamping sampler the cloud panorama is
	 *   read with until it streams in
	 */
	constructor(
		root: TgpuRoot,
		pipelines: PipelineCache,
		input: { postUniforms: GPUBuffer; sampler: GPUSampler },
	) {
		this.#root = root;
		this.#postGroup = root.createBindGroup(postUniformLayout, { post: input.postUniforms });
		this.#pipeline = pipelines.prepareTgpuRender('celestial', () =>
			root.createRenderPipeline({
				vertex: common.fullScreenTriangle,
				fragment: fsCelestial,
				targets: { format: HDR_FORMAT },
			}),
		);
		this.#noCloud = {
			view: placeholder(root.device, 'black', '2d'),
			sampler: input.sampler,
			version: -1,
		};
		this.#cloud = this.#noCloud;
		this.#uniforms = createUniformBuffer(root.device, 'celestial uniforms', UNIFORM_BYTES);
		this.#sampler = sampler(root.device, LINEAR_REPEAT_MIPMAPPED);
		this.#pointSampler = sampler(root.device, NEAREST_REPEAT);
		this.#black = placeholder(root.device, 'black', '2d');
		this.#layerGroup = this.#makeLayerGroup();
	}

	#makeLayerGroup(): TgpuBindGroup {
		const view = (slot: CelestialTextureSlot): GPUTextureView => this.#views.get(slot) ?? this.#black;
		return this.#root.createBindGroup(celestialLayerLayout, {
			celestial: this.#uniforms,
			sampler: this.#sampler,
			pointSampler: this.#pointSampler,
			nebula: view('nebula'),
			rayBase: view('rayBase'),
			rayRsm: view('rayRsm'),
			rayClouds: view('rayClouds'),
			rayLut: view('rayLut'),
			sky0Main: view('sky0Main'),
			sky0Emissive: view('sky0Emissive'),
			sky0Ring: view('sky0Ring'),
			sky1Main: view('sky1Main'),
			sky1Emissive: view('sky1Emissive'),
			sky1Ring: view('sky1Ring'),
			starDensity: view('starDensity'),
		});
	}

	/** @param look what to draw */
	setLook(look: CelestialLook): void {
		this.#look = look;
	}

	/**
	 * binds the textures as they stream in; a slot whose texture isn't resident yet draws nothing of its body
	 *
	 * @param binding gives each slot's binding, or `null`
	 */
	setTextures(binding: (slot: CelestialTextureSlot) => TextureBinding | null): void {
		let changed = false;
		for (const slot of CELESTIAL_TEXTURE_SLOTS) {
			const view = binding(slot)?.view ?? this.#black;
			if (this.#views.get(slot) !== view) {
				this.#views.set(slot, view);
				changed = true;
			}
		}
		if (changed) {
			this.#layerGroup = this.#makeLayerGroup();
			if (this.#sized !== null) {
				this.#sized.pass.groups = [this.#postGroup, this.#layerGroup, this.#sized.sceneGroup];
				this.#sized.pass.bound = undefined;
			}
		}
	}

	/** @returns whether the cloud panorama is bound */
	get hasCloud(): boolean {
		return this.#cloud !== this.#noCloud;
	}

	/**
	 * binds the cloud panorama, once it streams in.
	 *
	 * @param cloud the texture's binding, or `null` for none
	 */
	setCloud(cloud: TextureBinding | null): void {
		const next = cloud ?? this.#noCloud;
		if (next === this.#cloud) {
			return;
		}
		this.#cloud = next;
		if (this.#sized !== null) {
			this.resize(this.#sized);
		}
	}

	/**
	 * rebinds the inputs after they were recreated.
	 *
	 * @param input the main pass's depth, and the target: its sky reflection target, where sky pixels are
	 *   overwritten and surface pixels are kept for the composite
	 */
	resize(input: { depth: GPUTextureView; target: GPUTextureView }): void {
		const { depth, target } = input;
		const sceneGroup = this.#root.createBindGroup(celestialSceneLayout, {
			depth,
			cloud: this.#cloud.view,
			cloudSampler: this.#cloud.sampler,
		});
		this.#sized = {
			depth,
			target,
			sceneGroup,
			pass: {
				label: 'celestial',
				pipeline: this.#pipeline,
				groups: [this.#postGroup, this.#layerGroup, sceneGroup],
				target,
			},
		};
	}

	/**
	 * draws the layers for a frame
	 *
	 * @param encoder this frame's encoder, after the reflections
	 * @param input the camera's world position, the unit vector towards the scene's sun and its pre-exposed
	 *   illuminance
	 */
	encode(encoder: GPUCommandEncoder, input: { eye: Vec3; sun: Vec3; sunIlluminance: Vec3 }): void {
		const sized = this.#sized;
		if (sized === null) {
			throw new Error('celestial layer used before resize()');
		}
		this.#write(input.eye, input.sun, input.sunIlluminance);
		encodeTgpuFullscreen(encoder, sized.pass);
	}

	/**
	 * writes the uniforms for a frame
	 *
	 * @param eye the camera's world position
	 * @param sun unit vector towards the scene's sun
	 * @param sunIlluminance its pre-exposed illuminance
	 */
	#write(eye: Vec3, sun: Vec3, sunIlluminance: Vec3): void {
		const f = this.#data;
		const u = this.#words;
		f.fill(0);
		const look = this.#look;
		const has = (slot: CelestialTextureSlot): boolean =>
			(this.#views.get(slot) ?? this.#black) !== this.#black;
		const set = rowWriter(f);

		const disc = look.sun;
		if (disc !== null) {
			u[5] = 1;
			f.set([...disc.direction, disc.ramp], SUN_OFFSET);
			f.set([...disc.color, disc.sharpness], SUN_OFFSET + 4);
		}

		const nebula = look.nebula;
		if (nebula !== null && has('nebula')) {
			u[0] = 1;
			set(2, [...nebula.tint, nebula.rotation]);
			set(3, [nebula.planetMask, 0, 0, 0]);
		}

		const stars = look.stars;
		if (stars !== null && has('starDensity')) {
			u[4] = 1;
			for (const [i, param] of stars.params.entries()) {
				f.set(param, STAR_OFFSET + i * 4);
			}
		}

		const ray = look.ray;
		if (ray !== null && has('rayBase') && has('rayRsm') && has('rayClouds') && has('rayLut')) {
			u[1] = 1;
			const r = RAY_OFFSET;
			// in f64 here: the planet is hundreds of kilometres away
			const origin = [eye[0] - ray.center[0], eye[1] - ray.center[1], eye[2] - ray.center[2]];
			// `_LightDataBuffer._DirectionalLightColor` folds `1 / pi` in (`directIntensityDividePi`)
			const lightColor = ray.lightColor ?? sunIlluminance;
			const lightScale = ray.lightColor === null ? ray.lightScale / Math.PI : ray.lightScale;
			f.set([...origin, ray.radius], r);
			f.set([ray.groundRadius, ray.topRadius, ray.cloudRadius, ray.viewSamples], r + 4);
			f.set([...ray.scaleHeights, ray.mieAnisotropy, ray.useLut ? 1 : 0], r + 8);
			f.set([...ray.rayleigh, ray.brightness], r + 12);
			f.set([...ray.mie, ray.cloudShadows ? 1 : 0], r + 16);
			f.set([...(ray.light ?? sun), 0], r + 20);
			f.set([lightColor[0] * lightScale, lightColor[1] * lightScale, lightColor[2] * lightScale], r + 24);
			f.set(ray.tilt[0], r + 28);
			f.set(ray.tilt[1], r + 32);
			f.set(ray.tilt[2], r + 36);
			f.set([ray.spin, ray.baseTransform[2], ray.baseTransform[0], ray.baseTransform[1]], r + 40);
			f.set(ray.tint, r + 44);
			f.set(ray.seaShallow, r + 48);
			f.set(ray.seaDeep, r + 52);
			f.set(ray.fresnel, r + 56);
			f.set(ray.indirect, r + 60);
			f.set(ray.cloudShadow, r + 64);
			f.set(ray.ambient, r + 68);
			f.set([ray.cloudAlpha, ray.cloudBrightness, ray.roughness, ray.roughnessFromMap ? 1 : 0], r + 72);
		}

		for (const [i, planet] of look.sky.entries()) {
			if (planet === null || !has(i === 0 ? 'sky0Main' : 'sky1Main')) {
				continue;
			}
			u[2 + i] = 1;
			const s = SKY_OFFSET + i * SKY_STRIDE;
			const atmosphere = planet.atmosphere;
			f.set([...planet.center, 1], s);
			f.set(planet.up, s + 4);
			f.set(planet.forward, s + 8);
			f.set(planet.right, s + 12);
			f.set([...planet.light, atmosphere === null ? 0 : 1], s + 16);
			f.set([planet.radius, ...planet.ring], s + 20);
			f.set([...planet.color, atmosphere?.unlit ?? 0], s + 24);
			f.set([...planet.emissive, planet.horizonFade], s + 28);
			f.set(planet.ringColor, s + 32);
			f.set([planet.sharpness, planet.backFace, planet.ringShadowSoftness, 0], s + 36);
			if (atmosphere !== null) {
				f.set(
					[atmosphere.height, atmosphere.viewSamples, atmosphere.scattering, atmosphere.planetRadius],
					s + 40,
				);
				f.set(
					[atmosphere.lightSamples, atmosphere.falloff, atmosphere.brightness, atmosphere.hueShift],
					s + 44,
				);
				f.set(
					planet.center.map((c) => c * atmosphere.distance),
					s + 48,
				);
			}
		}
		this.#root.device.queue.writeBuffer(this.#uniforms, 0, f);
	}

	/** releases the GPU objects */
	destroy(): void {
		this.#uniforms.destroy();
	}
}
