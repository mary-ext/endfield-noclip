/**
 * mip feedback reduction compute shader: reduces the main pass's `r32uint` feedback target to the finest
 * footprint each material's UV sets were sampled with, sampling one pixel of each `STRIDE`^2 block per
 * frame.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

/** one pixel of each `STRIDE` x `STRIDE` block is read per frame */
export const MIP_FEEDBACK_STRIDE = 4;

/** uniform parameters for {@link csMipFeedbackReduce} */
export const MipFeedbackParams = d.struct({
	/** which pixel of each block to read */
	offset: d.vec2u,
	/** look slots `seen` has room for */
	looks: d.u32,
});

/** bind group layout for {@link csMipFeedbackReduce} */
export const mipFeedbackLayout = tgpu.bindGroupLayout({
	feedback: { texture: d.texture2d(d.u32) },
	seen: { storage: d.arrayOf(d.atomic(d.u32)), access: 'mutable' },
	params: { uniform: MipFeedbackParams },
});

/** compute entrypoint reducing per-pixel mip feedback into per-look max quarter-level footprints */
export const csMipFeedbackReduce = tgpu.computeFn({
	workgroupSize: [8, 8],
	in: { id: d.builtin.globalInvocationId },
})((input) => {
	'use gpu';
	const params = mipFeedbackLayout.$.params;
	const px = std.add(std.mul(input.id.xy, MIP_FEEDBACK_STRIDE), params.offset);
	if (std.any(std.ge(px, std.textureDimensions(mipFeedbackLayout.$.feedback)))) {
		return;
	}
	const packed = std.textureLoad(mipFeedbackLayout.$.feedback, px, 0).x;
	const look = packed & 0x1ffff;
	if ((packed & d.u32(0x80000000)) === 0 || look >= params.looks) {
		return;
	}
	std.atomicMax(mipFeedbackLayout.$.seen[look * 2], ((packed >>> 17) & 127) + 1);
	std.atomicMax(mipFeedbackLayout.$.seen[look * 2 + 1], ((packed >>> 24) & 127) + 1);
});
