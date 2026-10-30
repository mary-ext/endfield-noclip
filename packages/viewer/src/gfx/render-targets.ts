/**
 * the canvas swapchain and the targets the main pass renders into, kept at the canvas's device-pixel size.
 *
 * the main pass renders HDR radiance and its ambient part, one sample per pixel at the render size (the
 * canvas size times the render scale); depth is kept for the post passes (ambient occlusion, fog, sky).
 * temporal antialiasing resolves the render size up to the output (canvas) size, and post-processing then
 * writes the swapchain. the game has no MSAA either; its antialiasing is temporal.
 *
 * @module
 */

/** reversed-Z depth: 1 at the near plane, 0 at infinity; cleared to 0 and tested with `greater` */
export const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';

/** the depth clear value under reversed-Z */
export const DEPTH_CLEAR = 0;

/** the depth comparison under reversed-Z */
export const DEPTH_COMPARE: GPUCompareFunction = 'greater';

/** HDR colour format of the main pass and the post chain */
export const HDR_FORMAT: GPUTextureFormat = 'rgba16float';

/** what lit surfaces hand the screen-space reflections, packed (`pack_reflection_surface` in frame.wgsl) */
export const REFLECTION_SURFACE_FORMAT: GPUTextureFormat = 'rg32uint';

/**
 * the main pass's colour targets, in `@location` order: radiance, its ambient part, the sky reflection the
 * radiance holds, and what the screen-space reflections need of the surface. together they fill WebGPU's
 * default 32 bytes per sample
 */
export const MAIN_TARGETS: GPUColorTargetState[] = [
	{ format: HDR_FORMAT },
	{ format: HDR_FORMAT },
	{ format: HDR_FORMAT },
	{ format: REFLECTION_SURFACE_FORMAT },
];

/**
 * the transparent pass's colour targets (weighted blended order-independent transparency, McGuire and Bavoil
 * 2013): the weighted sum of premultiplied colours with the weights' sum in alpha, and the revealage, the
 * product of `1 − alpha` over the layers. the composite resolves them over the opaque scene
 */
export const TRANSPARENT_TARGETS: GPUColorTargetState[] = [
	{
		format: HDR_FORMAT,
		blend: {
			color: { srcFactor: 'one', dstFactor: 'one' },
			alpha: { srcFactor: 'one', dstFactor: 'one' },
		},
	},
	{
		format: 'r8unorm',
		blend: {
			color: { srcFactor: 'zero', dstFactor: 'one-minus-src' },
			alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src' },
		},
	},
];

/** what a main-pass pipeline needs to know of the targets */
export interface MainPassFormat {
	targets: GPUColorTargetState[];
}

/** the main pass's outputs, which the post passes read */
export interface SceneTextures {
	radiance: GPUTextureView;
	/** the texture behind {@link radiance}; unused once composited, so post passes may copy into it */
	radianceTexture: GPUTexture;
	ambient: GPUTextureView;
	/** rgb: the sky reflection in {@link radiance} */
	reflection: GPUTextureView;
	/** the surface's normal, roughness and screen-space reflection weight, packed; 0 where nothing lit was drawn */
	reflectionSurface: GPUTextureView;
	depth: GPUTextureView;
	/** the transparent pass's weighted colour sum ({@link TRANSPARENT_TARGETS}) */
	transparent: GPUTextureView;
	/** the transparent pass's revealage: 1 where nothing transparent was drawn */
	revealage: GPUTextureView;
	/** bumped whenever the views or the output size change (resize, render scale) */
	version: number;
}

/** owns the canvas context, the depth buffer and the HDR targets */
export class RenderTargets {
	readonly context: GPUCanvasContext;
	/** swapchain format */
	readonly colorFormat: GPUTextureFormat;
	/** the main pass's size, px */
	width = 1;
	height = 1;
	/** device pixels of the drawing buffer */
	outputWidth = 1;
	outputHeight = 1;
	/** the render size relative to the output size, (0, 1]; applied at the next {@link update} */
	renderScale = 1;

	#device: GPUDevice;
	#canvas: HTMLCanvasElement;
	#observer: ResizeObserver;
	#cssSize: [width: number, height: number] = [1, 1];
	#devicePixelSize: [width: number, height: number] | null = null;
	#textures: GPUTexture[] = [];
	#depth: GPUTexture | null = null;
	#colors: GPUTexture[] | null = null;
	#transparent: GPUTexture[] | null = null;
	#scene: SceneTextures | null = null;
	#version = 0;

	/**
	 * @param device the device
	 * @param canvas the canvas to present to; observed for size changes
	 * @param colorFormat swapchain format
	 */
	constructor(device: GPUDevice, canvas: HTMLCanvasElement, colorFormat: GPUTextureFormat) {
		this.#device = device;
		this.#canvas = canvas;
		this.colorFormat = colorFormat;
		const context = canvas.getContext('webgpu');
		if (context === null) {
			throw new Error(`couldn't get a WebGPU canvas context`);
		}
		this.context = context;
		context.configure({ device, format: colorFormat, alphaMode: 'opaque' });

		this.#observer = new ResizeObserver(([entry]) => {
			const box = entry.contentBoxSize[0];
			this.#cssSize = [box.inlineSize, box.blockSize];
			// exact device pixels where supported (Chrome), so the canvas maps 1:1 to the screen
			const pixels = entry.devicePixelContentBoxSize?.[0];
			this.#devicePixelSize = pixels === undefined ? null : [pixels.inlineSize, pixels.blockSize];
		});
		try {
			this.#observer.observe(canvas, { box: 'device-pixel-content-box' });
		} catch {
			this.#observer.observe(canvas);
		}
		const rect = canvas.getBoundingClientRect();
		this.#cssSize = [rect.width, rect.height];
	}

	/** @returns the main pass's target formats */
	get format(): MainPassFormat {
		return { targets: MAIN_TARGETS };
	}

	/**
	 * resizes the drawing buffer to the canvas's current size, and the targets to that times the render scale.
	 * call once per frame before rendering.
	 *
	 * @returns whether either size changed
	 */
	update(): boolean {
		const max = this.#device.limits.maxTextureDimension2D;
		const [cssWidth, cssHeight] = this.#cssSize;
		const [devicePixelWidth, devicePixelHeight] = this.#devicePixelSize ?? [
			cssWidth * devicePixelRatio,
			cssHeight * devicePixelRatio,
		];
		const outputWidth = Math.max(1, Math.min(max, Math.round(devicePixelWidth)));
		const outputHeight = Math.max(1, Math.min(max, Math.round(devicePixelHeight)));
		const width = Math.max(1, Math.round(outputWidth * this.renderScale));
		const height = Math.max(1, Math.round(outputHeight * this.renderScale));
		if (
			width === this.width &&
			height === this.height &&
			outputWidth === this.outputWidth &&
			outputHeight === this.outputHeight &&
			this.#depth !== null
		) {
			return false;
		}
		this.outputWidth = outputWidth;
		this.outputHeight = outputHeight;
		this.#canvas.width = outputWidth;
		this.#canvas.height = outputHeight;
		this.width = width;
		this.height = height;

		for (const texture of this.#textures) {
			texture.destroy();
		}
		this.#textures = [];
		const create = (descriptor: GPUTextureDescriptor): GPUTexture => {
			const texture = this.#device.createTexture(descriptor);
			this.#textures.push(texture);
			return texture;
		};
		const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
		this.#depth = create({ label: 'depth', size: [width, height], format: DEPTH_FORMAT, usage });
		this.#colors = [
			create({
				label: 'radiance',
				size: [width, height],
				format: HDR_FORMAT,
				usage: usage | GPUTextureUsage.COPY_DST,
			}),
			create({ label: 'ambient', size: [width, height], format: HDR_FORMAT, usage }),
			create({ label: 'reflection', size: [width, height], format: HDR_FORMAT, usage }),
			create({
				label: 'reflection surface',
				size: [width, height],
				format: REFLECTION_SURFACE_FORMAT,
				usage,
			}),
		];
		this.#transparent = [
			create({ label: 'transparent', size: [width, height], format: HDR_FORMAT, usage }),
			create({ label: 'revealage', size: [width, height], format: 'r8unorm', usage }),
		];
		this.#version++;
		this.#scene = {
			radiance: this.#colors[0].createView(),
			radianceTexture: this.#colors[0],
			ambient: this.#colors[1].createView(),
			reflection: this.#colors[2].createView(),
			reflectionSurface: this.#colors[3].createView(),
			depth: this.#depth.createView(),
			transparent: this.#transparent[0].createView(),
			revealage: this.#transparent[1].createView(),
			version: this.#version,
		};
		return true;
	}

	/** @returns bytes held by the targets (estimate; the swapchain counts as two buffers) */
	get bytes(): number {
		return this.width * this.height * (4 + 8 * 4 + 8 + 1) + this.outputWidth * this.outputHeight * 4 * 2;
	}

	/** @returns the main pass's outputs */
	get scene(): SceneTextures {
		if (this.#scene === null) {
			throw new Error('render targets used before update()');
		}
		return this.#scene;
	}

	/** @returns attachments for this frame's main pass, cleared to black */
	mainPassAttachments(): {
		colors: GPURenderPassColorAttachment[];
		depth: GPURenderPassDepthStencilAttachment;
	} {
		if (this.#depth === null || this.#colors === null) {
			throw new Error('render targets used before update()');
		}
		const clear: GPUColor = { r: 0, g: 0, b: 0, a: 0 };
		const colors = this.#colors.map((texture): GPURenderPassColorAttachment => ({
			view: texture.createView(),
			clearValue: clear,
			loadOp: 'clear',
			storeOp: 'store',
		}));
		return {
			colors,
			depth: {
				view: this.#depth.createView(),
				depthClearValue: DEPTH_CLEAR,
				depthLoadOp: 'clear',
				depthStoreOp: 'store',
			},
		};
	}

	/**
	 * @returns attachments for this frame's transparent pass: its targets cleared to nothing drawn, and the
	 *   main pass's depth, tested but not written
	 */
	transparentPassAttachments(): {
		colors: GPURenderPassColorAttachment[];
		depth: GPURenderPassDepthStencilAttachment;
	} {
		if (this.#depth === null || this.#transparent === null) {
			throw new Error('render targets used before update()');
		}
		const [sum, revealage] = this.#transparent;
		return {
			colors: [
				{ view: sum.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
				{
					view: revealage.createView(),
					clearValue: { r: 1, g: 1, b: 1, a: 1 },
					loadOp: 'clear',
					storeOp: 'store',
				},
			],
			depth: { view: this.#depth.createView(), depthReadOnly: true },
		};
	}

	/** @returns this frame's swapchain view */
	swapchainView(): GPUTextureView {
		return this.context.getCurrentTexture().createView();
	}

	/** stops observing the canvas and frees the targets */
	destroy(): void {
		this.#observer.disconnect();
		for (const texture of this.#textures) {
			texture.destroy();
		}
		this.context.unconfigure();
	}
}
