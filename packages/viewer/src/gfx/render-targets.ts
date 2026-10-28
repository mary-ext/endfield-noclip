/**
 * the canvas swapchain and the targets the main pass renders into, kept at the canvas's device-pixel size.
 *
 * the main pass renders HDR radiance and its ambient part into multisampled targets that resolve into
 * single-sample textures; depth is kept for the post passes (ambient occlusion, fog, sky). post-processing
 * then writes the swapchain.
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
	sampleCount: number;
}

/** the resolved targets the post passes read */
export interface SceneTextures {
	radiance: GPUTextureView;
	ambient: GPUTextureView;
	/** multisampled when the main pass is; read sample 0 */
	depth: GPUTextureView;
	/** bumped whenever the views change (resize) */
	version: number;
}

/** owns the canvas context, the depth buffer and the HDR targets */
export class RenderTargets {
	readonly context: GPUCanvasContext;
	/** swapchain format */
	readonly colorFormat: GPUTextureFormat;
	readonly sampleCount: number;
	/** device pixels of the drawing buffer */
	width = 1;
	height = 1;
	/** multiplier on the device pixel ratio (render scale) */
	scale = 1;

	#device: GPUDevice;
	#canvas: HTMLCanvasElement;
	#observer: ResizeObserver;
	#cssSize: [width: number, height: number] = [1, 1];
	#devicePixelSize: [width: number, height: number] | null = null;
	#textures: GPUTexture[] = [];
	#depth: GPUTexture | null = null;
	#msaa: [GPUTexture, GPUTexture] | null = null;
	#resolved: [GPUTexture, GPUTexture] | null = null;
	#scene: SceneTextures | null = null;
	#version = 0;

	/**
	 * @param device the device
	 * @param canvas the canvas to present to; observed for size changes
	 * @param colorFormat swapchain format
	 * @param sampleCount 1 or 4
	 */
	constructor(
		device: GPUDevice,
		canvas: HTMLCanvasElement,
		colorFormat: GPUTextureFormat,
		sampleCount: number,
	) {
		this.#device = device;
		this.#canvas = canvas;
		this.colorFormat = colorFormat;
		this.sampleCount = sampleCount;
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
		return { targets: MAIN_TARGETS, sampleCount: this.sampleCount };
	}

	/**
	 * resizes the drawing buffer and the targets to the canvas's current size. call once per frame before
	 * rendering.
	 *
	 * @returns whether the size changed
	 */
	update(): boolean {
		const max = this.#device.limits.maxTextureDimension2D;
		let [width, height] = this.#devicePixelSize ?? [
			this.#cssSize[0] * devicePixelRatio,
			this.#cssSize[1] * devicePixelRatio,
		];
		width = Math.max(1, Math.min(max, Math.round(width * this.scale)));
		height = Math.max(1, Math.min(max, Math.round(height * this.scale)));
		if (width === this.width && height === this.height && this.#depth !== null) {
			return false;
		}
		this.width = width;
		this.height = height;
		this.#canvas.width = width;
		this.#canvas.height = height;

		for (const texture of this.#textures) {
			texture.destroy();
		}
		this.#textures = [];
		const create = (descriptor: GPUTextureDescriptor): GPUTexture => {
			const texture = this.#device.createTexture(descriptor);
			this.#textures.push(texture);
			return texture;
		};
		const multisampled = this.sampleCount > 1;
		this.#depth = create({
			label: 'depth',
			size: [width, height],
			format: DEPTH_FORMAT,
			sampleCount: this.sampleCount,
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
		});
		const hdr = (label: string, sampleCount: number): GPUTexture =>
			create({
				label,
				size: [width, height],
				format: HDR_FORMAT,
				sampleCount,
				usage:
					sampleCount > 1
						? GPUTextureUsage.RENDER_ATTACHMENT
						: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
			});
		this.#resolved = [hdr('radiance', 1), hdr('ambient', 1)];
		this.#msaa = multisampled
			? [hdr('radiance msaa', this.sampleCount), hdr('ambient msaa', this.sampleCount)]
			: null;
		this.#version++;
		this.#scene = {
			radiance: this.#resolved[0].createView(),
			ambient: this.#resolved[1].createView(),
			depth: this.#depth.createView(),
			version: this.#version,
		};
		return true;
	}

	/** @returns bytes held by the targets (estimate; the swapchain counts as two buffers) */
	get bytes(): number {
		const pixels = this.width * this.height;
		const samples = this.sampleCount;
		return pixels * (4 * samples + (samples > 1 ? 16 * samples : 0) + 16 + 4 * 2);
	}

	/** @returns the resolved main-pass outputs */
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
		if (this.#depth === null || this.#resolved === null) {
			throw new Error('render targets used before update()');
		}
		const clear: GPUColor = { r: 0, g: 0, b: 0, a: 0 };
		const resolved = this.#resolved;
		const msaa = this.#msaa;
		const colors = resolved.map((texture, i): GPURenderPassColorAttachment =>
			msaa === null
				? { view: texture.createView(), clearValue: clear, loadOp: 'clear', storeOp: 'store' }
				: {
						view: msaa[i].createView(),
						resolveTarget: texture.createView(),
						clearValue: clear,
						loadOp: 'clear',
						storeOp: 'discard',
					},
		);
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
