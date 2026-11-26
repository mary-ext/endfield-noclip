/**
 * screen-space camera lens raindrops (`HGRP/Rain/ScreenRainDropFX`).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { frameLayout } from '../core/frame-core.ts';

/** max simultaneous screen-space lens raindrops (`HGScreenRainDropFXRenderer`) */
export const MAX_SCREEN_DROPS = 30;

/** GPU schema of the screen-space raindrop uniform block */
export const ScreenDropParamsSchema = d.struct({
	occOrigin: d.vec4f,
	occMetrics: d.vec4f,
	color: d.vec4f,
	params: d.vec4f,
	edge: d.vec4f,
	noiseSt: d.vec4f,
	drops: d.arrayOf(d.vec4f, MAX_SCREEN_DROPS),
});

/** byte size of {@link ScreenDropParamsSchema} */
export const SCREEN_DROP_BYTES = d.sizeOf(ScreenDropParamsSchema);

/** group 2 bind group layout for screen-space lens raindrops */
export const screenDropLayout = tgpu
	.bindGroupLayout({
		dropData: { uniform: ScreenDropParamsSchema },
		verticalOcclusion: { texture: d.textureDepth2d() },
		verticalOcclusionCompare: { sampler: 'comparison' },
		verticalOcclusionRaw: { sampler: 'non-filtering' },
		noiseTex: { texture: d.texture2d(d.f32) },
		noiseSampler: { sampler: 'filtering' },
	})
	.$idx(2);

const QUAD_VERTS = tgpu.const(d.arrayOf(d.vec2f, 6), [
	d.vec2f(-0.5, -0.5),
	d.vec2f(0.5, -0.5),
	d.vec2f(0.5, 0.5),
	d.vec2f(-0.5, -0.5),
	d.vec2f(0.5, 0.5),
	d.vec2f(-0.5, 0.5),
]);

const DropOut = {
	position: d.builtin.position,
	uv: d.vec2f,
	screenUv: d.vec2f,
	lifeAlpha: d.f32,
};

/** vertex entrypoint expanding each active screen-space lens raindrop into an NDC quad */
export const vsScreenDrop = tgpu.vertexFn({
	in: {
		vid: d.builtin.vertexIndex,
		iid: d.builtin.instanceIndex,
	},
	out: DropOut,
})((input) => {
	'use gpu';
	const drop = screenDropLayout.$.dropData.drops[input.iid];
	const corner = QUAD_VERTS.$[input.vid];
	const renderSize = frameLayout.$.frame.renderSize;
	const aspect = renderSize.x / std.max(renderSize.y, 1);
	const ndc = std.add(drop.xy, std.mul(d.vec2f(corner.x, corner.y * aspect), drop.w));
	const suv = d.vec2f(ndc.x * 0.5 + 0.5, (ndc.y * 0.5 + 0.5) / std.max(aspect, 0.01));
	return {
		position: d.vec4f(ndc, 0, 1),
		uv: std.add(corner, d.vec2f(0.5)),
		screenUv: suv,
		lifeAlpha: drop.z,
	};
});

/** fragment entrypoint shading screen-space lens raindrops */
export const fsScreenDrop = tgpu.fragmentFn({
	in: DropOut,
	out: d.vec4f,
})((input) => {
	'use gpu';
	const dropData = screenDropLayout.$.dropData;
	const occUv = d.vec2f(
		0.5 - dropData.occOrigin.x * dropData.occOrigin.w,
		0.5 + dropData.occOrigin.z * dropData.occOrigin.w,
	);
	const occZ = dropData.occOrigin.y * dropData.occMetrics.x;
	let exposed = d.f32(1);
	if (
		dropData.occMetrics.w > 0.5 &&
		std.all(std.gt(occUv, d.vec2f(0))) &&
		std.all(std.lt(occUv, d.vec2f(1))) &&
		occZ > 0 &&
		occZ < 1
	) {
		exposed = std.textureSampleCompareLevel(
			screenDropLayout.$.verticalOcclusion,
			screenDropLayout.$.verticalOcclusionCompare,
			occUv,
			std.max(occZ, 0.00048828125),
		);
	}
	if (exposed <= 0.0005) {
		std.discard();
	}
	const noise = std.textureSampleLevel(
		screenDropLayout.$.noiseTex,
		screenDropLayout.$.noiseSampler,
		std.add(std.mul(input.screenUv, dropData.noiseSt.xy), dropData.noiseSt.zw),
		0,
	).x;
	const radius = std.max(dropData.params.x * (1 + (noise * 2 - 1) * dropData.params.y), 1e-4);
	const fadeLo = dropData.params.z;
	const fadeHi = std.max(dropData.params.w, fadeLo + 1e-4);
	const edgeMask = std.smoothstep(fadeLo, fadeHi, std.length(std.sub(input.screenUv, d.vec2f(0.5))));
	const sharp = std.min(dropData.edge.z, 0.99);
	const dropMask = 1 - std.smoothstep(radius * sharp, radius, std.length(std.sub(input.uv, d.vec2f(0.5))));
	const alpha = std.saturate(
		edgeMask * dropMask * dropData.color.w * std.saturate(input.lifeAlpha) * noise * exposed,
	);
	if (alpha <= 0.0005) {
		std.discard();
	}
	return d.vec4f(dropData.color.xyz, alpha);
});
