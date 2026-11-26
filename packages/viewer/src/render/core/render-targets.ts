import { KEEP, PREMULTIPLIED_OVER } from '../../gfx/blend.ts';

/** the main pass target the meshes report into (`Shaded.mip_feedback` in frame-core.ts) */
const MIP_FEEDBACK_FORMAT: GPUTextureFormat = 'r32uint';

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

/** depth format of shadow maps (sun shadow fallback, local-light shadow atlas, vertical occlusion) */
export const SHADOW_FORMAT: GPUTextureFormat = 'depth32float';

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

/** G-buffer A (`metallic`, `occlusion`, `porosity`, `shadingModel` or foliage/SSS terms) */
export const GBUFFER_A_FORMAT: GPUTextureFormat = 'rgb10a2unorm';

/** G-buffer B (octahedral world normal, perceptual roughness, valid / decal-reject flags) */
export const GBUFFER_B_FORMAT: GPUTextureFormat = 'rgb10a2unorm';

/** G-buffer C (sRGB albedo, plus foliage AO or subsurface amount in alpha) */
export const GBUFFER_C_FORMAT: GPUTextureFormat = 'rgba8unorm-srgb';

/** wetness decals' mask (`rg8unorm`, blended with `max` before deferred lighting) */
export const WETNESS_MASK_FORMAT: GPUTextureFormat = 'rg8unorm';

/** dynamic object screen-space velocity delta (`dyn_prev_uv - static_prev_uv`, 0 on static pixels) */
const VELOCITY_FORMAT: GPUTextureFormat = 'rg16float';

/**
 * the main pass's G-buffer targets, in `@location` order: HDR emission (`rgba16float`), G-buffer A/B/C, mip
 * feedback (`r32uint`), and dynamic velocity (`rg16float`). 40 bytes/sample in WebGPU's attachment budget
 */
const MAIN_TARGETS: GPUColorTargetState[] = [
	{ format: HDR_FORMAT },
	{ format: GBUFFER_A_FORMAT },
	{ format: GBUFFER_B_FORMAT },
	{ format: GBUFFER_C_FORMAT },
	{ format: MIP_FEEDBACK_FORMAT },
	{ format: VELOCITY_FORMAT },
];

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

/** the main pass's outputs, which decals, AO, SSR, deferred lighting and composite read */
export interface SceneTextures {
	/** HDR emission (or unlit final colour) from the main pass */
	emission: GPUTextureView;
	gbufferA: GPUTextureView;
	gbufferB: GPUTextureView;
	gbufferC: GPUTextureView;
	/**
	 * lit HDR scene (`celestial` on sky pixels, `deferred lighting` on surface pixels); after `composite`
	 * finishes, reused as the background copy target for water and refracting effects
	 */
	lit: GPUTextureView;
	/** the texture behind {@link lit} */
	litTexture: GPUTexture;
	/** `HGRP/WetnessDecal` max-blended wetness mask (`WETNESS_MASK_FORMAT`) */
	wetnessMask: GPUTextureView;
	/** the depth aspect alone, for sampling */
	depth: GPUTextureView;
	/** the nearest water surface's depth in front of the scene, {@link WATER_DEPTH_FORMAT}; 0 where there's none */
	waterDepth: GPUTextureView;
	/** the meshes' mip feedback (`pack_mip_feedback` in frame-core.ts) */
	mipFeedback: GPUTextureView;
	/** dynamic object screen-space velocity delta (`VELOCITY_FORMAT`, 0 on static pixels) */
	velocity: GPUTextureView;
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
	#depthCopy: GPUTexture | null = null;
	#depthCopyView: GPUTextureView | null = null;
	#colors: GPUTexture[] | null = null;
	#lit: GPUTexture | null = null;
	#wetnessMask: GPUTexture | null = null;
	#gbufferACopy: GPUTexture | null = null;
	#gbufferACopyView: GPUTextureView | null = null;
	#gbufferBCopy: GPUTexture | null = null;
	#gbufferBCopyView: GPUTextureView | null = null;
	#waterDepth: GPUTexture | null = null;
	#scene: SceneTextures | null = null;
	/** the passes' attachments, built on first use after each resize */
	#mainAttachments: PassAttachments | null = null;
	#transparentDepth: GPURenderPassDepthStencilAttachment | null = null;
	#writableTransparentDepth: GPURenderPassDepthStencilAttachment | null = null;
	#readOnlyDepth: GPURenderPassDepthStencilAttachment | null = null;
	#readOnlyWaterDepth: GPURenderPassDepthStencilAttachment | null = null;
	#writableDepth: GPURenderPassDepthStencilAttachment | null = null;
	#version = 0;

	/**
	 * @param device the device
	 * @param canvas the canvas to present to; observed for size changes
	 * @param colorFormat swapchain format
	 * @param features `stencil` gives depth a stencil buffer, which needs the `depth32float-stencil8` feature
	 */
	constructor(
		device: GPUDevice,
		canvas: HTMLCanvasElement,
		colorFormat: GPUTextureFormat,
		{ stencil }: { stencil: boolean },
	) {
		this.#device = device;
		this.#canvas = canvas;
		this.colorFormat = colorFormat;
		this.format = {
			targets: MAIN_TARGETS,
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
		this.#depth = create({
			label: 'depth',
			size: [width, height],
			format: this.format.depth,
			usage: usage | GPUTextureUsage.COPY_SRC,
		});
		this.#depthCopy = null;
		this.#depthCopyView = null;
		this.#gbufferACopy = null;
		this.#gbufferACopyView = null;
		this.#gbufferBCopy = null;
		this.#gbufferBCopyView = null;
		this.#colors = [
			create({ label: 'gbuffer emission', size: [width, height], format: HDR_FORMAT, usage }),
			create({
				label: 'gbuffer A',
				size: [width, height],
				format: GBUFFER_A_FORMAT,
				usage: usage | GPUTextureUsage.COPY_SRC,
			}),
			create({
				label: 'gbuffer B',
				size: [width, height],
				format: GBUFFER_B_FORMAT,
				usage: usage | GPUTextureUsage.COPY_SRC,
			}),
			create({ label: 'gbuffer C', size: [width, height], format: GBUFFER_C_FORMAT, usage }),
			create({ label: 'mip feedback', size: [width, height], format: MIP_FEEDBACK_FORMAT, usage }),
			create({ label: 'velocity', size: [width, height], format: VELOCITY_FORMAT, usage }),
		];
		this.#lit = create({
			label: 'lit scene',
			size: [width, height],
			format: HDR_FORMAT,
			usage: usage | GPUTextureUsage.COPY_DST,
		});
		this.#wetnessMask = create({
			label: 'wetness mask',
			size: [width, height],
			format: WETNESS_MASK_FORMAT,
			usage,
		});
		this.#waterDepth = create({
			label: 'water depth',
			size: [width, height],
			format: WATER_DEPTH_FORMAT,
			usage,
		});
		this.#version++;
		this.#mainAttachments = null;
		this.#transparentDepth = null;
		this.#writableTransparentDepth = null;
		this.#readOnlyDepth = null;
		this.#readOnlyWaterDepth = null;
		this.#writableDepth = null;
		this.#scene = {
			emission: this.#colors[0].createView(),
			gbufferA: this.#colors[1].createView(),
			gbufferB: this.#colors[2].createView(),
			gbufferC: this.#colors[3].createView(),
			lit: this.#lit.createView(),
			litTexture: this.#lit,
			wetnessMask: this.#wetnessMask.createView(),
			depth: this.#depth.createView({ aspect: 'depth-only' }),
			waterDepth: this.#waterDepth.createView(),
			mipFeedback: this.#colors[4].createView(),
			velocity: this.#colors[5].createView(),
			version: this.#version,
		};
		return true;
	}

	/** @returns bytes held by the targets (estimate; the swapchain counts as two buffers) */
	get bytes(): number {
		// depth with stencil is commonly stored as 8 bytes
		const depth = this.format.stencil ? 8 : 4;
		// G-buffer + velocity (28 B) + lit (8 B) + wetnessMask (2 B) + waterDepth (4 B) + optional copies
		const copies = (this.#depthCopy !== null ? depth : 0) + (this.#gbufferACopy !== null ? 8 : 0);
		return (
			this.width * this.height * (depth + 28 + 8 + 2 + 4 + copies) +
			this.outputWidth * this.outputHeight * 4 * 2
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
	 * copies the main pass's depth into a scratch texture so effects in a depth-writing transparent pass can
	 * sample opaque scene depth without conflicting with the writable depth attachment
	 *
	 * @param encoder command encoder to record the copy into
	 * @returns a depth-only view of the copy
	 */
	copyDepth(encoder: GPUCommandEncoder): GPUTextureView {
		if (this.#depth === null) {
			throw new Error('render targets used before update()');
		}
		if (this.#depthCopy === null || this.#depthCopyView === null) {
			this.#depthCopy = this.#device.createTexture({
				label: 'depth copy',
				size: [this.width, this.height],
				format: this.format.depth,
				usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
			});
			this.#textures.push(this.#depthCopy);
			this.#depthCopyView = this.#depthCopy.createView({ aspect: 'depth-only' });
		}
		encoder.copyTextureToTexture({ texture: this.#depth }, { texture: this.#depthCopy }, [
			this.width,
			this.height,
		]);
		return this.#depthCopyView;
	}

	/**
	 * copies `gbufferA` and `gbufferB` into scratch textures so the G-buffer decal pass can sample underlying
	 * normals, roughness and PBR channels while writing into the live G-buffer
	 *
	 * @param encoder command encoder to record the copies into
	 * @returns views of the copies
	 */
	copyGBufferAB(encoder: GPUCommandEncoder): { gbufferA: GPUTextureView; gbufferB: GPUTextureView } {
		if (this.#colors === null) {
			throw new Error('render targets used before update()');
		}
		if (
			this.#gbufferACopy === null ||
			this.#gbufferACopyView === null ||
			this.#gbufferBCopy === null ||
			this.#gbufferBCopyView === null
		) {
			const usage = GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING;
			this.#gbufferACopy = this.#device.createTexture({
				label: 'gbuffer A copy',
				size: [this.width, this.height],
				format: GBUFFER_A_FORMAT,
				usage,
			});
			this.#gbufferBCopy = this.#device.createTexture({
				label: 'gbuffer B copy',
				size: [this.width, this.height],
				format: GBUFFER_B_FORMAT,
				usage,
			});
			this.#textures.push(this.#gbufferACopy, this.#gbufferBCopy);
			this.#gbufferACopyView = this.#gbufferACopy.createView();
			this.#gbufferBCopyView = this.#gbufferBCopy.createView();
		}
		encoder.copyTextureToTexture({ texture: this.#colors[1] }, { texture: this.#gbufferACopy }, [
			this.width,
			this.height,
		]);
		encoder.copyTextureToTexture({ texture: this.#colors[2] }, { texture: this.#gbufferBCopy }, [
			this.width,
			this.height,
		]);
		return { gbufferA: this.#gbufferACopyView, gbufferB: this.#gbufferBCopyView };
	}

	/**
	 * @returns the depth attachment of a transparent pass that has depth-writing draws (`_Zwrite`): both depth
	 *   and stencil stay writable, keeping main-pass depth loaded; the same object until the next resize
	 */
	writableTransparentDepthAttachment(): Readonly<GPURenderPassDepthStencilAttachment> {
		if (this.#depth === null) {
			throw new Error('render targets used before update()');
		}
		if (this.#writableTransparentDepth !== null) {
			return this.#writableTransparentDepth;
		}
		const depth: GPURenderPassDepthStencilAttachment = {
			view: this.#depth.createView(),
			depthLoadOp: 'load',
			depthStoreOp: 'store',
		};
		if (this.format.stencil) {
			depth.stencilLoadOp = 'load';
			depth.stencilStoreOp = 'discard';
		}
		this.#writableTransparentDepth = depth;
		return depth;
	}

	/**
	 * @returns the main pass's depth, kept and writable, its stencil read-only, for opaque effects drawn over
	 *   the composited scene; the same object until the next resize
	 */
	writableDepthAttachment(): Readonly<GPURenderPassDepthStencilAttachment> {
		if (this.#depth === null) {
			throw new Error('render targets used before update()');
		}
		if (this.#writableDepth !== null) {
			return this.#writableDepth;
		}
		const depth: GPURenderPassDepthStencilAttachment = {
			view: this.#depth.createView(),
			depthLoadOp: 'load',
			depthStoreOp: 'store',
		};
		if (this.format.stencil) {
			depth.stencilReadOnly = true;
		}
		this.#writableDepth = depth;
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

	/**
	 * @returns the nearest water surface's depth ({@link SceneTextures.waterDepth}), attached for testing only;
	 *   the same object until the next resize
	 */
	readOnlyWaterDepthAttachment(): Readonly<GPURenderPassDepthStencilAttachment> {
		if (this.#waterDepth === null) {
			throw new Error('render targets used before update()');
		}
		this.#readOnlyWaterDepth ??= { view: this.#waterDepth.createView(), depthReadOnly: true };
		return this.#readOnlyWaterDepth;
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
