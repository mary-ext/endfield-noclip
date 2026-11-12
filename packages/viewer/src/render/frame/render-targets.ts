import { KEEP, PREMULTIPLIED_OVER } from '../../gfx/blend.ts';
import { MIP_FEEDBACK_FORMAT } from '../textures/mip-feedback.ts';

/**
 * reversed-Z depth: 1 at the near plane, 0 at infinity; cleared to 0 and tested with `greater`. with a
 * stencil buffer, {@link DEPTH_STENCIL_FORMAT} instead
 */
export const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';

/**
 * {@link DEPTH_FORMAT} plus a stencil buffer, cleared to 0 and written only by the effects that mask each
 * other (`LookStencil` in looks/look.ts); needs the `depth32float-stencil8` feature
 */
const DEPTH_STENCIL_FORMAT: GPUTextureFormat = 'depth32float-stencil8';

/** the nearest water surface's depth (reversed-Z like the main pass's) */
export const WATER_DEPTH_FORMAT: GPUTextureFormat = 'depth32float';

/** the depth clear value under reversed-Z */
export const DEPTH_CLEAR = 0;

/** the depth comparison under reversed-Z */
export const DEPTH_COMPARE: GPUCompareFunction = 'greater';

/** HDR colour format of the main pass and the post chain */
export const HDR_FORMAT: GPUTextureFormat = 'rgba16float';

/**
 * the water's foam colour that WaterDecal boxes draw into, rgb, with alpha what's left of the water's own
 * foam. 8-bit like the game's target, so the foam saturates at 1 as the game's does
 */
export const WATER_FOAM_FORMAT: GPUTextureFormat = 'rgba8unorm';

/** what lit surfaces hand the screen-space reflections, packed (reflection-surface.wgsl) */
const REFLECTION_SURFACE_FORMAT: GPUTextureFormat = 'rg32uint';

/**
 * the main pass's colour targets, in `@location` order: radiance, its ambient part, the sky reflection the
 * radiance holds, and what the screen-space reflections need of the surface. together they fill WebGPU's
 * default 32 bytes per sample
 */
const MAIN_TARGETS: GPUColorTargetState[] = [
	{ format: HDR_FORMAT },
	{ format: HDR_FORMAT },
	{ format: HDR_FORMAT },
	{ format: REFLECTION_SURFACE_FORMAT },
];

/**
 * {@link MAIN_TARGETS} and the meshes' mip feedback (`Shaded.mip_feedback` in frame.wgsl), where the device
 * takes 36 bytes per sample; without the target, pipelines drop that output
 */
const MAIN_TARGETS_WITH_FEEDBACK: GPUColorTargetState[] = [...MAIN_TARGETS, { format: MIP_FEEDBACK_FORMAT }];

/**
 * the transparent pass's colour target: the composited scene, which each transparent draw blends over, far to
 * near, as the game draws its transparent queue. shaders write fogged premultiplied colour and their opacity
 * (0 for additive light), and the scene's alpha stays as the composite left it
 */
export const TRANSPARENT_TARGETS: GPUColorTargetState[] = [
	{ format: HDR_FORMAT, blend: { color: PREMULTIPLIED_OVER, alpha: KEEP } },
];

/** what a main-pass pipeline needs to know of the targets */
export interface MainPassFormat {
	targets: GPUColorTargetState[];
	/** {@link DEPTH_FORMAT} or {@link DEPTH_STENCIL_FORMAT}, which the transparent pass shares */
	depth: GPUTextureFormat;
	/** whether {@link depth} has a stencil aspect */
	stencil: boolean;
}

/** a render pass's attachments, reused across frames: begin passes with them, don't modify them */
export interface PassAttachments {
	readonly colors: GPURenderPassColorAttachment[];
	readonly depth: GPURenderPassDepthStencilAttachment;
}

/** the main pass's outputs, which the post passes read */
export interface SceneTextures {
	radiance: GPUTextureView;
	/** the texture behind {@link radiance}; unused once composited, so post passes may copy into it */
	radianceTexture: GPUTexture;
	ambient: GPUTextureView;
	/**
	 * rgb: the sky reflection in {@link radiance}. the screen-space reflections are its last reader; the
	 * celestial pass then draws into it
	 */
	reflection: GPUTextureView;
	/** the surface's normal, roughness and screen-space reflection weight, packed; 0 where nothing lit was drawn */
	reflectionSurface: GPUTextureView;
	/** the depth aspect alone, for sampling */
	depth: GPUTextureView;
	/** the nearest water surface's depth in front of the scene, {@link WATER_DEPTH_FORMAT}; 0 where there's none */
	waterDepth: GPUTextureView;
	/**
	 * the meshes' mip feedback (`pack_mip_feedback` in frame.wgsl), or `null` where the device has no room for
	 * it
	 */
	mipFeedback: GPUTextureView | null;
	/** bumped whenever the views or the output size change (resize, render scale) */
	version: number;
}

/** owns the canvas context, the depth buffer and the HDR targets */
export class RenderTargets {
	readonly context: GPUCanvasContext;
	/** swapchain format */
	readonly colorFormat: GPUTextureFormat;
	/** the main pass's targets */
	readonly format: MainPassFormat;
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
	#waterDepth: GPUTexture | null = null;
	#scene: SceneTextures | null = null;
	/** the passes' attachments, built on first use after each resize */
	#mainAttachments: PassAttachments | null = null;
	#transparentDepth: GPURenderPassDepthStencilAttachment | null = null;
	#readOnlyDepth: GPURenderPassDepthStencilAttachment | null = null;
	#version = 0;

	/**
	 * @param device the device
	 * @param canvas the canvas to present to; observed for size changes
	 * @param colorFormat swapchain format
	 * @param features `stencil` gives depth a stencil buffer, which needs the `depth32float-stencil8` feature;
	 *   `mipFeedback` gives the main pass its mip feedback target, which needs 36 bytes per sample of colour
	 *   targets
	 */
	constructor(
		device: GPUDevice,
		canvas: HTMLCanvasElement,
		colorFormat: GPUTextureFormat,
		{ stencil, mipFeedback }: { stencil: boolean; mipFeedback: boolean },
	) {
		this.#device = device;
		this.#canvas = canvas;
		this.colorFormat = colorFormat;
		this.format = {
			targets: mipFeedback ? MAIN_TARGETS_WITH_FEEDBACK : MAIN_TARGETS,
			depth: stencil ? DEPTH_STENCIL_FORMAT : DEPTH_FORMAT,
			stencil,
		};
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
		this.#depth = create({ label: 'depth', size: [width, height], format: this.format.depth, usage });
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
		if (this.format.targets.length > MAIN_TARGETS.length) {
			this.#colors.push(
				create({ label: 'mip feedback', size: [width, height], format: MIP_FEEDBACK_FORMAT, usage }),
			);
		}
		this.#waterDepth = create({
			label: 'water depth',
			size: [width, height],
			format: WATER_DEPTH_FORMAT,
			usage,
		});
		this.#version++;
		this.#mainAttachments = null;
		this.#transparentDepth = null;
		this.#readOnlyDepth = null;
		this.#scene = {
			radiance: this.#colors[0].createView(),
			radianceTexture: this.#colors[0],
			ambient: this.#colors[1].createView(),
			reflection: this.#colors[2].createView(),
			reflectionSurface: this.#colors[3].createView(),
			depth: this.#depth.createView({ aspect: 'depth-only' }),
			waterDepth: this.#waterDepth.createView(),
			mipFeedback: this.#colors[MAIN_TARGETS.length]?.createView() ?? null,
			version: this.#version,
		};
		return true;
	}

	/** @returns bytes held by the targets (estimate; the swapchain counts as two buffers) */
	get bytes(): number {
		// depth with stencil is commonly stored as 8 bytes
		const depth = this.format.stencil ? 8 : 4;
		const feedback = this.format.targets.length > MAIN_TARGETS.length ? 4 : 0;
		return (
			this.width * this.height * (depth + 8 * 4 + 4 + feedback) + this.outputWidth * this.outputHeight * 4 * 2
		);
	}

	/** @returns the main pass's outputs */
	get scene(): SceneTextures {
		if (this.#scene === null) {
			throw new Error('render targets used before update()');
		}
		return this.#scene;
	}

	/** @returns attachments for this frame's main pass, cleared to black; the same objects until the next resize */
	mainPassAttachments(): PassAttachments {
		if (this.#depth === null || this.#colors === null) {
			throw new Error('render targets used before update()');
		}
		if (this.#mainAttachments !== null) {
			return this.#mainAttachments;
		}
		const clear: GPUColor = { r: 0, g: 0, b: 0, a: 0 };
		const colors = this.#colors.map((texture): GPURenderPassColorAttachment => ({
			view: texture.createView(),
			clearValue: clear,
			loadOp: 'clear',
			storeOp: 'store',
		}));
		const depth: GPURenderPassDepthStencilAttachment = {
			view: this.#depth.createView(),
			depthClearValue: DEPTH_CLEAR,
			depthLoadOp: 'clear',
			depthStoreOp: 'store',
		};
		if (this.format.stencil) {
			depth.stencilClearValue = 0;
			depth.stencilLoadOp = 'clear';
			depth.stencilStoreOp = 'store';
		}
		this.#mainAttachments = { colors, depth };
		return this.#mainAttachments;
	}

	/**
	 * @returns the depth attachment of this frame's transparent pass, which draws over the composited scene
	 *   ({@link TRANSPARENT_TARGETS}): the main pass's depth, tested but not written. the stencil stays
	 *   writable, since some effects mask the ones drawn after them. the same object until the next resize
	 */
	transparentDepthAttachment(): Readonly<GPURenderPassDepthStencilAttachment> {
		if (this.#depth === null) {
			throw new Error('render targets used before update()');
		}
		if (this.#transparentDepth !== null) {
			return this.#transparentDepth;
		}
		const depth: GPURenderPassDepthStencilAttachment = {
			view: this.#depth.createView(),
			depthReadOnly: true,
		};
		if (this.format.stencil) {
			depth.stencilLoadOp = 'load';
			depth.stencilStoreOp = 'discard';
		}
		this.#transparentDepth = depth;
		return depth;
	}

	/**
	 * @returns the main pass's depth, attached for testing only, for effects drawn over the composited scene;
	 *   the same object until the next resize
	 */
	readOnlyDepthAttachment(): Readonly<GPURenderPassDepthStencilAttachment> {
		if (this.#depth === null) {
			throw new Error('render targets used before update()');
		}
		if (this.#readOnlyDepth !== null) {
			return this.#readOnlyDepth;
		}
		const depth: GPURenderPassDepthStencilAttachment = {
			view: this.#depth.createView(),
			depthReadOnly: true,
		};
		if (this.format.stencil) {
			depth.stencilReadOnly = true;
		}
		this.#readOnlyDepth = depth;
		return depth;
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
