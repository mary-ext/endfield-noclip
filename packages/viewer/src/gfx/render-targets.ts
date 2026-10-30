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

/** the main pass's colour targets, in `@location` order: radiance, then its ambient part */
export const MAIN_TARGETS: GPUColorTargetState[] = [{ format: HDR_FORMAT }, { format: HDR_FORMAT }];

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
	depth: GPUTextureView;
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
	#colours: [GPUTexture, GPUTexture] | null = null;
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
		this.#colours = [
			create({
				label: 'radiance',
				size: [width, height],
				format: HDR_FORMAT,
				usage: usage | GPUTextureUsage.COPY_DST,
			}),
			create({ label: 'ambient', size: [width, height], format: HDR_FORMAT, usage }),
		];
		this.#version++;
		this.#scene = {
			radiance: this.#colours[0].createView(),
			radianceTexture: this.#colours[0],
			ambient: this.#colours[1].createView(),
			depth: this.#depth.createView(),
			version: this.#version,
		};
		return true;
	}

	/** @returns bytes held by the targets (estimate; the swapchain counts as two buffers) */
	get bytes(): number {
		return this.width * this.height * (4 + 8 * 2) + this.outputWidth * this.outputHeight * 4 * 2;
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
		if (this.#depth === null || this.#colours === null) {
			throw new Error('render targets used before update()');
		}
		const clear: GPUColor = { r: 0, g: 0, b: 0, a: 0 };
		const colors = this.#colours.map((texture): GPURenderPassColorAttachment => ({
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
