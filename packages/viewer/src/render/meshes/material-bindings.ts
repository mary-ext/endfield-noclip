import { BindGroupCache } from '../../gfx/bind-group-cache.ts';
import { placeholder } from '../../gfx/placeholders.ts';
import { LINEAR_CLAMP, LINEAR_REPEAT_MIPMAPPED, sampler } from '../../gfx/samplers.ts';
import { LookFlags, type MaterialLook, SLOTS, SLOT_FLAGS } from '../../looks/look.ts';
import type { TextureBinding, TextureStore } from '../textures/texture-store.ts';

/** the main pass's outputs that scene effects read, as `SceneTextures` holds them */
export interface EffectInputs {
	depth: GPUTextureView;
	reflectionSurface: GPUTextureView;
	/** the diffuse ambient and material occlusion, from which relit decals recover the surface's colour */
	ambient: GPUTextureView;
	/** a copy of the composited scene, which refraction samples; only the pass after compositing has one */
	background?: GPUTextureView;
	version: number;
}

/** what a material's draws take from its textures' current bindings */
export interface MaterialState extends EffectMaterial {
	/** the texture store's version this was derived at */
	version: number;
	/** each slot's binding, `null` where it has no texture or it hasn't streamed in */
	slots: (TextureBinding | null)[];
	/** the look's 3D texture's binding, `null` where it has none or it hasn't streamed in */
	volume: TextureBinding | null;
	/** the look's flags without the flags of slots that aren't bound */
	flags: number;
	/** the material group; `null` for effects, whose group also binds the main pass's outputs */
	group: GPUBindGroup | null;
	/** whether the texture holding the alpha is bound, so alpha testing can run */
	alphaReady: boolean;
	/** whether every texture is bound, which effects wait for */
	complete: boolean;
}

/** an effect draw's material: what its group is built from when its pass encodes */
export interface EffectMaterial {
	material: number;
	slots: readonly (TextureBinding | null)[];
	volume: TextureBinding | null;
}

/** derives the mesh materials' states from their textures' bindings, and owns their bind groups */
/** whether none of a look's textures' bindings changed since the store's `version` */
const texturesUnchanged = (look: MaterialLook, textures: TextureStore, version: number): boolean => {
	for (let i = 0; i < SLOTS.length; i++) {
		const texture = look.textures[i];
		if (texture !== null && !textures.unchangedSince(texture, version)) {
			return false;
		}
	}
	return look.volumeTexture === null || textures.unchangedSince(look.volumeTexture, version);
};

export class MaterialBindings {
	#device: GPUDevice;
	#materialLayout: GPUBindGroupLayout;
	#effectLayout: GPUBindGroupLayout;
	#white: GPUTextureView;
	/** bound where an effect has no 3D texture */
	#noVolume: GPUTextureView;
	#defaultSampler: GPUSampler;
	/** samples the composited scene's copy for refraction */
	#clampSampler: GPUSampler;
	/** material bind groups by material id, over their slots' binding versions (-1 for the fallback) */
	#materialGroups = new BindGroupCache<number>();
	/** by material id */
	#states = new Map<number, MaterialState>();
	/** scratch for the versions a material group is looked up by */
	#versions: number[] = SLOTS.map(() => -1);
	/** effect bind groups by material id, over their slots' and volume's binding versions and the inputs' */
	#effectGroups = new BindGroupCache<number>();
	#effectParts: number[] = [...SLOTS.map(() => -1), -1, -1];
	/** stands in for the main pass's outputs while effects draw into them, as opaque layers do */
	readonly mainPassStandIns: EffectInputs;

	/**
	 * @param device the device
	 * @param materialLayout group 3 of the mesh pipelines
	 * @param effectLayout group 3 of the effect pipelines
	 */
	constructor(device: GPUDevice, materialLayout: GPUBindGroupLayout, effectLayout: GPUBindGroupLayout) {
		this.#device = device;
		this.#materialLayout = materialLayout;
		this.#effectLayout = effectLayout;
		this.#white = placeholder(device, 'white', '2d');
		this.#noVolume = placeholder(device, 'black', '3d');
		this.#defaultSampler = sampler(device, LINEAR_REPEAT_MIPMAPPED);
		this.#clampSampler = sampler(device, LINEAR_CLAMP);
		const standIn = (format: GPUTextureFormat) =>
			device
				.createTexture({
					label: `main pass stand-in ${format}`,
					size: [1, 1],
					format,
					usage: GPUTextureUsage.TEXTURE_BINDING,
				})
				.createView();
		// the frames' inputs count up from 0
		this.mainPassStandIns = {
			depth: standIn('depth32float'),
			reflectionSurface: standIn('rg32uint'),
			ambient: this.#white,
			version: -1,
		};
	}

	/** forgets every material's state and bind groups (when a package is unloaded) */
	release(): void {
		this.#materialGroups.clear();
		this.#states.clear();
		this.#effectGroups.clear();
	}

	/**
	 * @param material the material id
	 * @param look its look
	 * @param textures the package's textures
	 * @returns the material's state, derived again only after one of its textures' bindings changed
	 */
	state(material: number, look: MaterialLook, textures: TextureStore): MaterialState {
		const cached = this.#states.get(material);
		if (cached !== undefined && cached.version === textures.version) {
			return cached;
		}
		// while streaming the store changes every frame, but rarely under a given material
		if (cached !== undefined && texturesUnchanged(look, textures, cached.version)) {
			cached.version = textures.version;
			return cached;
		}
		const slots: (TextureBinding | null)[] = [];
		let flags = look.flags;
		let complete = true;
		for (let i = 0; i < SLOTS.length; i++) {
			const texture = look.textures[i];
			const binding = texture === null ? null : textures.binding(texture);
			slots.push(binding);
			if (binding === null) {
				flags &= ~SLOT_FLAGS[i];
				complete &&= texture === null;
			}
		}
		const volume = look.volumeTexture === null ? null : textures.binding(look.volumeTexture);
		complete &&= look.volumeTexture === null || volume !== null;
		const state: MaterialState = {
			material,
			version: textures.version,
			slots,
			volume,
			flags,
			group: (look.flags & LookFlags.Effect) !== 0 ? null : this.#materialGroup(material, slots),
			alphaReady: slots[(look.flags & LookFlags.AlphaNormal) !== 0 ? 1 : 0] !== null,
			complete,
		};
		this.#states.set(material, state);
		return state;
	}

	/** the material's bind group over its slots' current bindings (`null` slots get the white texture) */
	#materialGroup(material: number, slots: readonly (TextureBinding | null)[]): GPUBindGroup {
		const versions = this.#versions;
		for (let i = 0; i < slots.length; i++) {
			versions[i] = slots[i]?.version ?? -1;
		}
		return this.#materialGroups.get(material, versions, () => {
			const detail = slots[1] ?? slots[2] ?? slots[0];
			return this.#device.createBindGroup({
				label: `material ${material}`,
				layout: this.#materialLayout,
				entries: [
					...slots.map((slot, i) => ({ binding: i, resource: slot?.view ?? this.#white })),
					{ binding: SLOTS.length, resource: slots[0]?.sampler ?? this.#defaultSampler },
					{ binding: SLOTS.length + 1, resource: detail?.sampler ?? this.#defaultSampler },
					{ binding: SLOTS.length + 2, resource: slots[5]?.sampler ?? this.#defaultSampler },
				],
			});
		});
	}

	/**
	 * @param effect an effect material's slot bindings
	 * @param inputs this frame's main pass outputs
	 * @returns the effect material's bind group over its slots' current bindings and the outputs
	 */
	effectGroup({ material, slots, volume }: EffectMaterial, inputs: EffectInputs): GPUBindGroup {
		// the slots' versions, then the volume's and the inputs'
		const parts = this.#effectParts;
		for (let i = 0; i < slots.length; i++) {
			parts[i] = slots[i]?.version ?? -1;
		}
		parts[slots.length] = volume?.version ?? -1;
		parts[slots.length + 1] = inputs.version;
		return this.#effectGroups.get(material, parts, () =>
			this.#device.createBindGroup({
				label: `effect material ${material}`,
				layout: this.#effectLayout,
				entries: [
					...slots.map((slot, i) => ({ binding: i, resource: slot?.view ?? this.#white })),
					...slots.map((slot, i) => ({
						binding: SLOTS.length + i,
						resource: slot?.sampler ?? this.#defaultSampler,
					})),
					{ binding: 14, resource: inputs.depth },
					{ binding: 15, resource: inputs.reflectionSurface },
					{ binding: 16, resource: inputs.ambient },
					{ binding: 17, resource: volume?.view ?? this.#noVolume },
					{ binding: 18, resource: volume?.sampler ?? this.#defaultSampler },
					{ binding: 19, resource: inputs.background ?? this.#white },
					{ binding: 20, resource: this.#clampSampler },
				],
			}),
		);
	}
}
