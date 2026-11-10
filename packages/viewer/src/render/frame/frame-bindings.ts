import { placeholder } from '../../gfx/placeholders.ts';
import { LINEAR_CLAMP_MIPMAPPED, sampler } from '../../gfx/samplers.ts';
import type { IrradianceVolume } from '../lighting/irradiance-volume.ts';
import type { LocalLights } from '../lighting/local-lights.ts';
import { SHADOW_FORMAT, type ShadowMap } from '../shadows/shadow-map.ts';
import type { TextureBinding } from '../textures/texture-store.ts';

import { FRAME_UNIFORM_BYTES } from './frame-uniform-writer.ts';

/** the frame group's streamed 2D textures, each bound as a placeholder until it's resident */
export type FrameTextureSlot = 'shadowRamp' | 'cloudShadow';

/** the systems whose resources group 0 binds */
export interface FrameSources {
	/** the frame layout */
	layout: GPUBindGroupLayout;
	/** the uniform ring's buffer, bound at a dynamic offset */
	uniforms: GPUBuffer;
	shadows: ShadowMap;
	irradiance: IrradianceVolume;
	lights: LocalLights;
}

/**
 * group 0 for the main pass and the shadow passes, rebuilt whenever a bound texture changes. the streamed
 * textures (the reflection cubemap, the shadow ramp and the cloud shadow) are bound as placeholders until
 * they're resident; {@link has} says which are real.
 */
export class FrameBindings {
	/** group 0 of the main pass and the passes that light like it */
	main: GPUBindGroup;
	/** group 0 of the shadow passes, with a placeholder in place of the map they render into */
	shadow: GPUBindGroup;
	readonly #device: GPUDevice;
	readonly #sources: FrameSources;
	/** the shadow passes can't bind the map they render into */
	readonly #shadowPlaceholder: GPUTextureView;
	/** nor the local lights' atlas, which a tile's pass renders into */
	readonly #lightShadowPlaceholder: GPUTextureView;
	/** bound while the level has no reflection cubemap, or it hasn't streamed in */
	readonly #noReflection: TextureBinding;
	#reflection: TextureBinding;
	#reflectionMips = 0;
	/** bound while a slot's texture is absent; black */
	readonly #placeholders: Readonly<Record<FrameTextureSlot, GPUTextureView>>;
	readonly #views: Record<FrameTextureSlot, GPUTextureView>;

	/**
	 * @param device the device
	 * @param sources what the groups bind
	 */
	constructor(device: GPUDevice, sources: FrameSources) {
		this.#device = device;
		this.#sources = sources;
		this.#shadowPlaceholder = device
			.createTexture({
				label: 'shadow placeholder',
				size: [1, 1, 1],
				format: SHADOW_FORMAT,
				usage: GPUTextureUsage.TEXTURE_BINDING,
			})
			.createView({ dimension: '2d-array' });
		this.#lightShadowPlaceholder = device
			.createTexture({
				label: 'light shadow placeholder',
				size: [1, 1],
				format: SHADOW_FORMAT,
				usage: GPUTextureUsage.TEXTURE_BINDING,
			})
			.createView();
		this.#noReflection = {
			view: placeholder(device, 'black', 'cube'),
			sampler: sampler(device, LINEAR_CLAMP_MIPMAPPED),
			version: -1,
		};
		this.#reflection = this.#noReflection;
		this.#placeholders = {
			shadowRamp: placeholder(device, 'black', '2d'),
			cloudShadow: placeholder(device, 'black', '2d'),
		};
		this.#views = { ...this.#placeholders };
		[this.main, this.shadow] = this.#groups();
	}

	/** @returns mip levels of the bound reflection cubemap, minus one */
	get reflectionMips(): number {
		return this.#reflectionMips;
	}

	/**
	 * @param slot a streamed texture
	 * @returns whether it's bound, rather than its placeholder
	 */
	has(slot: FrameTextureSlot | 'reflection'): boolean {
		if (slot === 'reflection') {
			return this.#reflection !== this.#noReflection;
		}
		return this.#views[slot] !== this.#placeholders[slot];
	}

	/**
	 * binds a slot's texture, rebuilding the groups if it changed
	 *
	 * @param slot the slot
	 * @param view its view, or `null` for the placeholder
	 */
	set(slot: FrameTextureSlot, view: GPUTextureView | null): void {
		const next = view ?? this.#placeholders[slot];
		if (next !== this.#views[slot]) {
			this.#views[slot] = next;
			this.rebuild();
		}
	}

	/**
	 * binds the reflection cubemap, rebuilding the groups if its binding changed (the texture store hands out a
	 * new one then)
	 *
	 * @param binding the cubemap's binding, or `null` for the placeholder
	 * @param mipCount its mip levels, recorded along with a change
	 */
	setReflection(binding: TextureBinding | null, mipCount: number): void {
		const next = binding ?? this.#noReflection;
		if (next !== this.#reflection) {
			this.#reflection = next;
			this.#reflectionMips = mipCount - 1;
			this.rebuild();
		}
	}

	/** builds the groups again; call after the irradiance volume's textures change */
	rebuild(): void {
		[this.main, this.shadow] = this.#groups();
	}

	#groups(): [main: GPUBindGroup, shadow: GPUBindGroup] {
		const { layout, uniforms, shadows, irradiance, lights } = this.#sources;
		const reflection = this.#reflection;
		const clipmaps = irradiance.views();
		const group = (
			label: string,
			shadowView: GPUTextureView,
			lightShadowView: GPUTextureView,
		): GPUBindGroup =>
			this.#device.createBindGroup({
				label,
				layout,
				entries: [
					{ binding: 0, resource: { buffer: uniforms, size: FRAME_UNIFORM_BYTES } },
					{ binding: 1, resource: shadowView },
					{ binding: 2, resource: shadows.sampler },
					{ binding: 3, resource: reflection.view },
					{ binding: 4, resource: reflection.sampler },
					{ binding: 5, resource: clipmaps.a },
					{ binding: 6, resource: clipmaps.b },
					{ binding: 7, resource: irradiance.sampler },
					{ binding: 8, resource: irradiance.clampSampler },
					{ binding: 9, resource: shadows.gatherSampler },
					{ binding: 10, resource: this.#views.shadowRamp },
					{ binding: 11, resource: { buffer: lights.lightBuffer } },
					{ binding: 12, resource: { buffer: lights.binBuffer } },
					{ binding: 13, resource: this.#views.cloudShadow },
					{ binding: 14, resource: lightShadowView },
				],
			});
		return [
			group('frame', shadows.view, lights.shadows.view),
			group('shadow frame', this.#shadowPlaceholder, this.#lightShadowPlaceholder),
		];
	}
}
