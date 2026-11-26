/** bytes per texel of the formats render targets use; depth with stencil is commonly stored as 8 bytes */
const TEXEL_BYTES: Partial<Record<GPUTextureFormat, number>> = {
	r8unorm: 1,
	r16float: 2,
	r32float: 4,
	rg16float: 4,
	rg11b10ufloat: 4,
	rgba8unorm: 4,
	rgba16float: 8,
	rg32uint: 8,
	depth16unorm: 2,
	depth32float: 4,
	'depth32float-stencil8': 8,
};

/** what {@link TextureSet.create} takes: a 2D texture's description */
export interface SetTextureDescriptor {
	label: string;
	size: readonly [width: number, height: number];
	format: GPUTextureFormat;
	/** 1 by default */
	mipLevelCount?: number;
	/** `RENDER_ATTACHMENT | TEXTURE_BINDING` by default */
	usage?: GPUTextureUsageFlags;
}

/**
 * 2D textures made together, typically a pass's targets for one render size, and destroyed together when that
 * size changes
 */
export class TextureSet {
	#device: GPUDevice;
	#textures: GPUTexture[] = [];
	#bytes = 0;

	/** @param device the device */
	constructor(device: GPUDevice) {
		this.#device = device;
	}

	/** @returns bytes of every texture's levels */
	get bytes(): number {
		return this.#bytes;
	}

	/**
	 * @param descriptor the texture
	 * @returns a new texture, destroyed with the set
	 * @throws {Error} if the format isn't one the set knows the size of
	 */
	create(descriptor: SetTextureDescriptor): GPUTexture {
		const { label, size, format, mipLevelCount = 1 } = descriptor;
		const texelBytes = TEXEL_BYTES[format];
		if (texelBytes === undefined) {
			throw new Error(`texture set doesn't know the size of ${format}`);
		}
		const texture = this.#device.createTexture({
			label,
			size: [size[0], size[1]],
			format,
			mipLevelCount,
			usage: descriptor.usage ?? GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
		});
		this.#textures.push(texture);
		for (let level = 0; level < mipLevelCount; level++) {
			this.#bytes += Math.max(1, size[0] >> level) * Math.max(1, size[1] >> level) * texelBytes;
		}
		return texture;
	}

	/** destroys every texture; the set can be filled again */
	destroy(): void {
		for (const texture of this.#textures) {
			texture.destroy();
		}
		this.#textures = [];
		this.#bytes = 0;
	}
}
