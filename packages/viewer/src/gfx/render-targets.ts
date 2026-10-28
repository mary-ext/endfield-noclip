/**
 * the canvas swapchain and the targets the main pass renders into, kept at the canvas's device-pixel size.
 *
 * @module
 */

/** reversed-Z depth: 1 at the near plane, 0 at infinity; cleared to 0 and tested with `greater` */
export const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';

/** the depth clear value under reversed-Z */
export const DEPTH_CLEAR = 0;

/** the depth comparison under reversed-Z */
export const DEPTH_COMPARE: GPUCompareFunction = 'greater';

/** owns the canvas context, the depth buffer and the optional MSAA color target */
export class RenderTargets {
	readonly context: GPUCanvasContext;
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
	#depth: GPUTexture | null = null;
	#msaa: GPUTexture | null = null;

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

	/**
	 * resizes the drawing buffer and depth/MSAA targets to the canvas's current size. call once per frame
	 * before rendering.
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

		this.#depth?.destroy();
		this.#depth = this.#device.createTexture({
			label: 'depth',
			size: [width, height],
			format: DEPTH_FORMAT,
			sampleCount: this.sampleCount,
			usage: GPUTextureUsage.RENDER_ATTACHMENT,
		});
		this.#msaa?.destroy();
		this.#msaa =
			this.sampleCount > 1
				? this.#device.createTexture({
						label: 'msaa color',
						size: [width, height],
						format: this.colorFormat,
						sampleCount: this.sampleCount,
						usage: GPUTextureUsage.RENDER_ATTACHMENT,
					})
				: null;
		return true;
	}

	/** @returns bytes held by the targets (estimate; the swapchain counts as two buffers) */
	get bytes(): number {
		const pixels = this.width * this.height;
		return pixels * 4 * this.sampleCount + pixels * 4 * this.sampleCount + pixels * 4 * 2;
	}

	/**
	 * @param clear clear color
	 * @returns attachments for this frame's main pass
	 */
	mainPassAttachments(clear: GPUColor): {
		color: GPURenderPassColorAttachment;
		depth: GPURenderPassDepthStencilAttachment;
	} {
		const swapchain = this.context.getCurrentTexture().createView();
		if (this.#depth === null) {
			throw new Error('render targets used before update()');
		}
		return {
			color:
				this.#msaa === null
					? { view: swapchain, clearValue: clear, loadOp: 'clear', storeOp: 'store' }
					: {
							view: this.#msaa.createView(),
							resolveTarget: swapchain,
							clearValue: clear,
							loadOp: 'clear',
							storeOp: 'discard',
						},
			depth: {
				view: this.#depth.createView(),
				depthClearValue: DEPTH_CLEAR,
				depthLoadOp: 'clear',
				depthStoreOp: 'discard',
			},
		};
	}

	/** stops observing the canvas and frees the targets */
	destroy(): void {
		this.#observer.disconnect();
		this.#depth?.destroy();
		this.#msaa?.destroy();
		this.context.unconfigure();
	}
}
